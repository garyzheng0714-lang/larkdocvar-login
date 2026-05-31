// feishuUserDirectory.ts — 飞书用户目录搜索

import type { Method } from 'axios';
import {
  type DepartmentChildrenPage,
  type ContactUsersPage,
  type SearchUsersPage,
  type SearchUserResult,
} from './feishuTypes';

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

export function toSearchUser(
  value:
    | {
        open_id?: string;
        user_id?: string;
        name?: string;
        en_name?: string;
        nickname?: string;
        email?: string;
        department_ids?: string[];
        avatar?: { avatar_72?: string };
      }
    | {
        open_id?: string;
        user_id?: string;
        name?: string;
        department_ids?: string[];
        avatar?: { avatar_72?: string };
      },
  departmentNameById?: Map<string, string>,
  fallbackDepartmentId?: string
): SearchUserResult | null {
  if (!value.open_id) {
    return null;
  }
  const departmentIds = (value.department_ids || []).filter(Boolean);
  if (departmentIds.length === 0 && fallbackDepartmentId) {
    departmentIds.push(fallbackDepartmentId);
  }
  const departments = departmentIds
    .map((id) => departmentNameById?.get(id) || '')
    .filter((item) => !!item);
  return {
    openId: value.open_id,
    userId: value.user_id,
    name: value.name || value.user_id || value.open_id,
    enName: 'en_name' in value ? value.en_name : undefined,
    nickname: 'nickname' in value ? value.nickname : undefined,
    email: 'email' in value ? value.email : undefined,
    avatar72: value.avatar?.avatar_72,
    departmentIds,
    departments
  };
}

export function sortAndUniqueUsers(users: SearchUserResult[]): SearchUserResult[] {
  const unique = new Map<string, SearchUserResult>();
  for (const user of users) {
    if (!unique.has(user.openId)) {
      unique.set(user.openId, user);
    }
  }
  return Array.from(unique.values()).sort((a, b) => {
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function filterUsers(users: SearchUserResult[], keyword: string, limit: number): SearchUserResult[] {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return users.slice(0, limit);
  }
  const filtered = users.filter((user) => {
    const text = [
      user.name,
      user.nickname,
      user.enName,
      user.email,
      user.userId,
      user.openId,
      ...(user.departments || [])
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return text.includes(normalizedKeyword);
  });
  return filtered.slice(0, limit);
}

export async function listAllDepartments(request: <T>(method: Method, path: string, options?: { params?: Record<string, string | number | boolean>; data?: unknown; retries?: number }) => Promise<T>): Promise<Map<string, string>> {
  const departmentNameById = new Map<string, string>();
  departmentNameById.set('0', '根部门');
  let pageToken: string | undefined;
  while (true) {
    const data = await request<DepartmentChildrenPage>('GET', '/contact/v3/departments/0/children', {
      params: {
        department_id_type: 'open_department_id',
        fetch_child: true,
        page_size: 50,
        page_token: pageToken || ''
      }
    });
    for (const item of data.items || []) {
      const id = item.open_department_id || item.department_id;
      if (!id) {
        continue;
      }
      const name = item.name || item.i18n_name?.zh_cn || item.i18n_name?.en_us || item.i18n_name?.ja_jp || '';
      departmentNameById.set(id, name);
    }
    if (!data.has_more || !data.page_token) {
      break;
    }
    pageToken = data.page_token;
  }
  return departmentNameById;
}

export async function listUsersByDepartment(
  request: <T>(method: Method, path: string, options?: { params?: Record<string, string | number | boolean>; data?: unknown; retries?: number }) => Promise<T>,
  departmentId: string,
  departmentNameById: Map<string, string>
): Promise<SearchUserResult[]> {
  const users: SearchUserResult[] = [];
  let pageToken: string | undefined;
  while (true) {
    const data = await request<ContactUsersPage>('GET', '/contact/v3/users/find_by_department', {
      params: {
        user_id_type: 'open_id',
        department_id_type: 'open_department_id',
        department_id: departmentId,
        page_size: 50,
        page_token: pageToken || ''
      }
    });
    for (const item of data.items || []) {
      const user = toSearchUser(item, departmentNameById, departmentId);
      if (user) {
        users.push(user);
      }
    }
    if (!data.has_more || !data.page_token) {
      break;
    }
    pageToken = data.page_token;
  }
  return users;
}

export async function buildDirectoryUsers(request: <T>(method: Method, path: string, options?: { params?: Record<string, string | number | boolean>; data?: unknown; retries?: number }) => Promise<T>): Promise<SearchUserResult[]> {
  const departmentNameById = await listAllDepartments(request);
  const departmentIds = Array.from(departmentNameById.keys());

  // Batch process in parallel to avoid extremely slow sequential fetching, but limit concurrency to avoid rate limits
  const users: SearchUserResult[] = [];
  const concurrencyLimit = 5;

  for (let i = 0; i < departmentIds.length; i += concurrencyLimit) {
    const batch = departmentIds.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.all(
      batch.map(deptId => listUsersByDepartment(request, deptId, departmentNameById).catch(() => [] as SearchUserResult[]))
    );
    for (const deptUsers of batchResults) {
      users.push(...deptUsers);
    }
  }

  return sortAndUniqueUsers(users);
}

export async function trySearchUsersViaSearchApi(
  request: <T>(method: Method, path: string, options?: { params?: Record<string, string | number | boolean>; data?: unknown; retries?: number }) => Promise<T>,
  keyword: string,
  limit: number
): Promise<SearchUserResult[]> {
  const departmentNameById = await listAllDepartments(request);
  const data = await request<SearchUsersPage>('GET', '/search/v1/user', {
    params: {
      query: keyword,
      page_size: Math.min(Math.max(limit, 1), 50)
    }
  });
  const users = (data.users || [])
    .map((item) => toSearchUser(item, departmentNameById))
    .filter((item): item is SearchUserResult => item !== null);
  return sortAndUniqueUsers(users).slice(0, limit);
}

export const __test__ = {
  normalizeKeyword,
  toSearchUser,
  sortAndUniqueUsers,
  filterUsers,
};
