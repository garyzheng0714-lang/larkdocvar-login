// 模板库写锁：进程内排队 + 存储里的锁对象（_locks/document-templates.json），防止两个实例同时改 _index.json。
// 模板和变量词典共用这一把锁。
import { randomUUID } from 'node:crypto';
import { UserFacingError } from './documentRenderStorageErrors';
import { TemplateObjectAlreadyExistsError, TemplateObjectNotFoundError, type TemplateObjectStore } from './documentTemplateStorage';

const LOCK_KEY = '_locks/document-templates.json';
const LOCK_CONTENT_TYPE = 'application/json; charset=utf-8';
const LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_MAX_WAIT_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TemplateStoreMutex {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: TemplateObjectStore) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.inProcess(() => this.inStore(operation));
  }

  private async inProcess<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async inStore<T>(operation: () => Promise<T>): Promise<T> {
    const lockObjectName = this.store.objectName(LOCK_KEY);
    const token = randomUUID();
    const startedAt = Date.now();
    while (true) {
      try {
        await this.store.putObjectIfAbsent(
          LOCK_KEY,
          Buffer.from(JSON.stringify({
            token,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
          })),
          LOCK_CONTENT_TYPE,
        );
        try {
          return await operation();
        } finally {
          await this.release(lockObjectName, token);
        }
      } catch (error) {
        if (!(error instanceof TemplateObjectAlreadyExistsError)) throw error;
        await this.deleteIfExpired(lockObjectName);
        if (Date.now() - startedAt > LOCK_MAX_WAIT_MS) {
          throw new UserFacingError('模板库正在保存，请稍后重试。');
        }
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  private async read(lockObjectName: string): Promise<{ token?: string; expiresAt?: string } | null> {
    try {
      const buffer = await this.store.getObject(lockObjectName);
      const parsed = JSON.parse(buffer.toString('utf8')) as { token?: unknown; expiresAt?: unknown };
      return {
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
      };
    } catch (error) {
      if (error instanceof TemplateObjectNotFoundError) return null;
      return null;
    }
  }

  private async deleteIfExpired(lockObjectName: string): Promise<void> {
    const lock = await this.read(lockObjectName);
    if (!lock?.expiresAt) return;
    if (Date.parse(lock.expiresAt) > Date.now()) return;
    await this.store.deleteObject(lockObjectName).catch(() => undefined);
  }

  private async release(lockObjectName: string, token: string): Promise<void> {
    const lock = await this.read(lockObjectName);
    if (lock?.token !== token) return;
    await this.store.deleteObject(lockObjectName).catch(() => undefined);
  }
}
