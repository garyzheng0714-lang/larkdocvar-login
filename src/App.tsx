import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldType, ITable, bitable } from "@lark-base-open/js-sdk";
import { ChevronsUpDown, Check, ChevronDown, ChevronsRight, AlertCircle, CheckCircle, Info, Loader2, RefreshCw, Search, X, ExternalLink, Rocket, ImageIcon, Plus, Trash2, Type, Hash, CalendarDays, Sigma, Paperclip, Link2, ListFilter, FileText } from "lucide-react";

type GenerateMode = "selected" | "all";
type NoticeType = "info" | "success" | "error";
type WizardStep = "extract" | "configure" | "generate";

interface AuthUser {
  openId: string;
  name: string;
  enName?: string;
  email?: string;
  avatarUrl?: string;
}

interface AuthSession {
  user: AuthUser | null;
  isAuthenticated: boolean;
}

interface SavedConfigPayload {
  templateUrl?: string;
  templateTitle?: string;
  bindings?: Record<string, string>;
  linkConfigs?: Record<string, LinkFieldConfig>;
  attachmentConfigs?: Record<string, AttachmentFieldConfig>;
  outputFieldId?: string;
  titleFieldId?: string;
  collaborators?: Array<{
    user: OwnerCandidate | null;
    role: "full_access" | "edit" | "view";
  }>;
  advancedGeneration?: {
    ownerTransferEnabled?: boolean;
    ownerTransferNeedNotification?: boolean;
    ownerTransferRemoveOldOwner?: boolean;
    ownerTransferStayPut?: boolean;
    ownerTransferOldOwnerPerm?: "view" | "edit" | "full_access";
  };
}

interface SavedConfigDetailResponse {
  ok: true;
  config: {
    id: string;
    configName: string;
    payload: SavedConfigPayload;
    createdAt: string;
    updatedAt: string;
  };
}

interface AutoConfigResponse {
  ok: true;
  found: boolean;
  sync?: SyncStatusInfo;
  config?: {
    id: string;
    configName: string;
    payload: SavedConfigPayload;
    createdAt: string;
    updatedAt: string;
  } | null;
}

interface SavedTemplateItem {
  id: string;
  templateId: string;
  templateTitle: string;
  templateUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface SavedTemplatesResponse {
  ok: true;
  templates: SavedTemplateItem[];
  sync?: SyncStatusInfo;
}

interface SyncStatusInfo {
  ok: boolean;
  source: "bitable" | "disabled";
  message?: string;
  checkedAt: string;
}

interface AuthSessionResponse {
  ok: true;
  loggedIn?: boolean;
  user?: AuthUser;
  sync?: SyncStatusInfo;
}

interface Notice {
  type: NoticeType;
  text: string;
}

interface GenerateProgressState {
  visible: boolean;
  total: number;
  completed: number;
  phase: string;
}

interface TemplateVariablesResponse {
  ok: true;
  documentId: string;
  templateTitle: string;
  variables: string[];
}

interface GenerateApiResult {
  recordId: string;
  status: "success" | "failed";
  docUrl?: string;
  documentId?: string;
  documentTitle?: string;
  replacedBlocks?: number;
  warnings?: string[];
  error?: string;
}

interface GenerateResponse {
  ok: true;
  results: GenerateApiResult[];
}

interface OwnerCandidate {
  openId: string;
  userId?: string;
  name: string;
  enName?: string;
  nickname?: string;
  email?: string;
  avatar72?: string;
  departments?: string[];
}

interface OwnerSearchResponse {
  ok: true;
  users: OwnerCandidate[];
}

interface Collaborator {
  id: string;
  user: OwnerCandidate | null;
  role: 'full_access' | 'edit' | 'view';
  keyword: string;
  candidates: OwnerCandidate[];
  searchOpen: boolean;
  searchLoading: boolean;
  roleOpen: boolean;
}

interface FieldMetaLite {
  id: string;
  name: string;
  type: number;
  isPrimary?: boolean;
  property?: {
    tableId?: string;
    multiple?: boolean;
  };
}

/** Per-variable config when bound to a link field (SingleLink=18 / DuplexLink=21) */
interface LinkFieldConfig {
  /** Which field from the linked table to read */
  linkedFieldId: string;
}

/** Per-variable config when bound to an attachment field (Attachment=17) */
interface AttachmentFieldConfig {
  /** Image width in px (0 = auto/original) */
  imageWidth: number;
  widthMode?: "preset" | "custom";
}

interface AdvancedGenerationSettings {
  ownerTransferEnabled: boolean;
  ownerTransferNeedNotification: boolean;
  ownerTransferRemoveOldOwner: boolean;
  ownerTransferStayPut: boolean;
  ownerTransferOldOwnerPerm: "view" | "edit" | "full_access";
}

/** Sent to backend for each image variable */
interface ImageVariablePayload {
  urls: string[];
  width: number;
}

const LINK_FIELD_TYPES = new Set([
  FieldType.SingleLink,
  FieldType.DuplexLink,
]);
const ATTACHMENT_FIELD_TYPE = FieldType.Attachment;
const DEFAULT_IMAGE_WIDTH = 400;

const OUTPUT_FIELD_BASE_NAME = "生成文档链接";
const UNBOUND_FIELD_VALUE = "__unbound__";
const AUTO_OUTPUT_FIELD_VALUE = "__auto__";
const AUTO_TITLE_FIELD_VALUE = "__title_auto__";
const LINK_SUMMARY_VALUE = "__link_summary__";
const ATTACH_WIDTH_CUSTOM_VALUE = "__attach_width_custom__";

const COLLABORATOR_ROLES = [
  { id: "full_access" as const, label: "可管理" },
  { id: "edit" as const, label: "可编辑" },
  { id: "view" as const, label: "可阅读" },
];

const DEFAULT_ADVANCED_GENERATION_SETTINGS: AdvancedGenerationSettings = {
  ownerTransferEnabled: true,
  ownerTransferNeedNotification: false,
  ownerTransferRemoveOldOwner: false,
  ownerTransferStayPut: false,
  ownerTransferOldOwnerPerm: "full_access",
};

function normalizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[【】[\]()（）{}<>《》_.\-]/g, "");
}

function findBestMatchedField(
  variableName: string,
  fields: FieldMetaLite[],
): FieldMetaLite | undefined {
  const normalizedVariable = normalizeName(variableName);
  if (!normalizedVariable) {
    return undefined;
  }
  const exact = fields.find(
    (field) => normalizeName(field.name) === normalizedVariable,
  );
  if (exact) {
    return exact;
  }
  return fields.find((field) => {
    const normalizedField = normalizeName(field.name);
    return (
      normalizedField.includes(normalizedVariable) ||
      normalizedVariable.includes(normalizedField)
    );
  });
}

function autoBindVariables(
  variables: string[],
  fields: FieldMetaLite[],
): Record<string, string> {
  return variables.reduce<Record<string, string>>((acc, variable) => {
    const matched = findBestMatchedField(variable, fields);
    acc[variable] = matched?.id ?? "";
    return acc;
  }, {});
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractDocumentIdFromUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    return match?.[1] || "";
  } catch {
    const match = trimmed.match(/\/(?:docx|docs)\/([a-zA-Z0-9_]+)/);
    return match?.[1] || "";
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error ??
        payload?.message ??
        `请求失败（HTTP ${response.status}）`,
    );
  }
  if (!payload?.ok) {
    throw new Error(payload?.error ?? payload?.message ?? "接口返回异常");
  }
  return payload as T;
}

async function getSelectedRecordIds(table: ITable): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const selection = await bitable.base.getSelection();
    if (selection.recordId) {
      ids.add(selection.recordId);
    }
  } catch (error) {
    void error;
  }

  try {
    const activeView = await table.getActiveView();
    const activeViewWithSelect = activeView as unknown as {
      getSelectedRecordIdList?: () => Promise<string[]>;
    };
    if (typeof activeViewWithSelect.getSelectedRecordIdList === "function") {
      const fromView = await activeViewWithSelect.getSelectedRecordIdList();
      for (const id of fromView || []) {
        if (id) {
          ids.add(id);
        }
      }
    }
  } catch (error) {
    void error;
  }

  return Array.from(ids);
}

function normalizeFieldMeta(raw: unknown): FieldMetaLite | null {
  const value = raw as Record<string, unknown>;
  const id = (value.id ?? value.fieldId ?? value.field_id) as
    | string
    | undefined;
  const name = (value.name ?? value.fieldName ?? value.field_name) as
    | string
    | undefined;
  const typeRaw = (value.type ?? value.fieldType ?? value.field_type) as
    | number
    | string
    | undefined;

  if (!id || !name) {
    return null;
  }
  const type = Number(typeRaw ?? FieldType.Text);
  const prop = value.property as Record<string, unknown> | undefined;
  const result: FieldMetaLite = {
    id,
    name,
    type: Number.isFinite(type) ? type : FieldType.Text,
    isPrimary: Boolean(value.isPrimary ?? value.is_primary ?? false),
  };
  if (prop) {
    result.property = {
      tableId: (prop.tableId ?? prop.table_id) as string | undefined,
      multiple: prop.multiple as boolean | undefined,
    };
  }
  return result;
}

function normalizeFieldMetaList(list: unknown[]): FieldMetaLite[] {
  const map = new Map<string, FieldMetaLite>();
  for (const item of list) {
    const meta = normalizeFieldMeta(item);
    if (!meta) {
      continue;
    }
    map.set(meta.id, meta);
  }
  return Array.from(map.values());
}

async function getFieldMetaListSafe(table: ITable): Promise<FieldMetaLite[]> {
  const raw = (await table.getFieldMetaList()) as unknown[];
  return normalizeFieldMetaList(raw);
}

async function getAllRecordIds(table: ITable): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: number | undefined;
  while (true) {
    const page = await table.getRecordIdListByPage({
      pageSize: 200,
      pageToken,
    });
    ids.push(...page.recordIds);
    if (!page.hasMore || page.pageToken === undefined) {
      break;
    }
    pageToken = page.pageToken;
  }
  return ids;
}

function getUniqueOutputFieldName(fields: FieldMetaLite[]): string {
  const existing = new Set(fields.map((field) => field.name));
  if (!existing.has(OUTPUT_FIELD_BASE_NAME)) {
    return OUTPUT_FIELD_BASE_NAME;
  }
  let suffix = 2;
  while (existing.has(`${OUTPUT_FIELD_BASE_NAME}${suffix}`)) {
    suffix += 1;
  }
  return `${OUTPUT_FIELD_BASE_NAME}${suffix}`;
}

function getOutputFieldCandidates(fields: FieldMetaLite[]): FieldMetaLite[] {
  return fields.filter((field) =>
    [FieldType.Text, FieldType.Url].includes(field.type as FieldType),
  );
}

type FieldIconKey =
  | "text"
  | "number"
  | "date"
  | "formula"
  | "attachment"
  | "link"
  | "url"
  | "select"
  | "field";

function getFieldTypeVisual(type: number): { icon: FieldIconKey; label: string } {
  switch (type as FieldType) {
    case FieldType.Formula:
      return { icon: "formula", label: "公式" };
    case FieldType.Attachment:
      return { icon: "attachment", label: "附件" };
    case FieldType.Number:
      return { icon: "number", label: "数字" };
    case FieldType.DateTime:
      return { icon: "date", label: "日期" };
    case FieldType.SingleSelect:
    case FieldType.MultiSelect:
      return { icon: "select", label: "选项" };
    case FieldType.SingleLink:
    case FieldType.DuplexLink:
      return { icon: "link", label: "关联" };
    case FieldType.Url:
      return { icon: "url", label: "链接" };
    case FieldType.Text:
      return { icon: "text", label: "文本" };
    default:
      return { icon: "field", label: "字段" };
  }
}

function FieldTypeIcon({ icon, className = "w-[14px] h-[14px]" }: { icon: FieldIconKey; className?: string }) {
  switch (icon) {
    case "text":
      return <Type className={className} />;
    case "number":
      return <Hash className={className} />;
    case "date":
      return <CalendarDays className={className} />;
    case "formula":
      return <Sigma className={className} />;
    case "attachment":
      return <Paperclip className={className} />;
    case "link":
      return <Link2 className={className} />;
    case "url":
      return <ExternalLink className={className} />;
    case "select":
      return <ListFilter className={className} />;
    default:
      return <FileText className={className} />;
  }
}

function formatDateTimeDisplay(input: string): string {
  const raw = input.trim();
  if (!raw) return "-";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  const pad = (num: number) => String(num).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function FeishuMark({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M891.306667 340.821333c4.906667 0 9.728 0.298667 14.634666 0.853334a409.941333 409.941333 0 0 1 108.8 30.037333c10.112 4.522667 12.629333 8.192 3.968 17.322667a351.146667 351.146667 0 0 0-61.013333 89.984c-16.810667 35.328-35.072 69.845333-52.266667 105.002666A225.28 225.28 0 0 1 853.333333 653.44c-53.632 48.512-116.181333 68.992-187.562666 59.093333-81.92-11.306667-159.445333-38.954667-232.704-75.477333a141.738667 141.738667 0 0 1-10.496-5.461333 5.376 5.376 0 0 1-1.706667-7.338667 5.333333 5.333333 0 0 1 2.005333-1.877333l5.12-2.730667c59.264-31.658667 108.842667-75.861333 156.544-122.282667 20.181333-19.541333 39.466667-40.021333 59.904-59.306666a344.96 344.96 0 0 1 160.170667-85.802667c13.184-3.242667 26.538667-5.802667 39.808-8.661333h0.554667l28.245333-2.56" fill="#133C9A" />
      <path d="M317.653333 913.834667c-8.96-0.512-31.146667-3.584-33.877333-3.968a536.576 536.576 0 0 1-165.077333-48.256c-30.208-14.08-59.221333-30.72-88.32-46.933334-19.2-10.666667-27.818667-27.306667-27.690667-49.92 0.597333-83.370667 0.597333-166.741333 0-250.154666C2.432 461.013333 0.725333 407.381333 0 353.706667c0-4.736 0.725333-9.514667 2.176-13.909334 3.328-9.728 9.984-10.24 16.554667-3.925333 7.594667 7.296 13.653333 16.213333 21.205333 23.381333 67.285333 66.432 138.752 127.189333 218.752 177.237334a1207.765333 1207.765333 0 0 0 140.458667 77.397333c77.738667 35.328 157.525333 66.474667 241.066666 86.186667 73.898667 17.493333 145.621333 6.485333 205.482667-40.362667 18.261333-15.616 27.264-27.050667 48.896-55.893333-9.642667 25.642667-22.186667 50.090667-37.376 72.874666-13.866667 21.973333-45.312 51.2-69.162667 74.112-36.266667 35.114667-83.754667 63.573333-128.298666 87.552-48.554667 26.154667-99.029333 47.104-152.96 58.496-27.648 6.954667-67.584 14.848-81.322667 15.573334-2.432-0.128-10.666667 1.706667-14.848 1.408-35.541333 2.645333-57.472 3.669333-92.885333 0h-0.085334z" fill="#3370FF" />
      <path d="M165.12 110.506667a52.48 52.48 0 0 1 7.424 0c152.661333 0 304.128 2.474667 456.618667 2.474666 0.298667 0 0.597333 0 0.725333 0.213334 14.208 12.373333 27.306667 25.770667 39.296 40.192 34.432 34.218667 60.16 93.610667 77.653333 129.706666 8.789333 25.045333 21.973333 48.896 28.16 76.8v0.469334c-15.573333 5.034667-30.72 11.178667-45.312 18.517333-44.202667 22.357333-64.213333 38.741333-100.821333 74.752-19.968 19.498667-36.992 37.077333-63.488 62.08-9.6 9.344-19.498667 18.346667-29.738667 26.922667-7.04-12.416-125.738667-244.608-364.245333-427.306667" fill="#00D6B9" />
    </svg>
  );
}

function formatWarnings(warnings: string[] | undefined): string {
  if (!warnings || warnings.length === 0) {
    return "";
  }
  return warnings.join("；");
}

function buildWriteBackValue(url: string): string {
  return url;
}

function formatOwnerLabel(user: OwnerCandidate): string {
  if (!user.nickname || user.nickname === user.name) {
    return user.name;
  }
  return `${user.name}（${user.nickname}）`;
}

function buildAvatarText(user: OwnerCandidate): string {
  const base = (user.name || "").trim();
  if (base) {
    return base.slice(0, 2);
  }
  return user.openId.slice(-2).toUpperCase();
}

function getAvatarColor(user: OwnerCandidate): string {
  const colors = [
    "#3370ff",
    "#d26a9a",
    "#00a870",
    "#8f77ff",
    "#e0893b",
    "#4f6fde",
  ];
  let hash = 0;
  for (let index = 0; index < user.openId.length; index += 1) {
    hash = (hash * 31 + user.openId.charCodeAt(index)) >>> 0;
  }
  return colors[hash % colors.length];
}

// --- Custom UI Components ---

type SelectOption = {
  value: string;
  label: string;
  typeIcon?: FieldIconKey;
  typeLabel?: string;
  searchText?: string;
};

function useOnClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      handlerRef.current();
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref]);
}

// 1. Field Mapping Select (Matches Screenshot 1)
function MappingSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  isWarning = false,
  compact = false,
  searchable = false,
}: {
  value: string;
  onChange: (val: string) => void;
  options: SelectOption[];
  placeholder?: string;
  isWarning?: boolean;
  compact?: boolean;
  searchable?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setIsOpen(false));

  const selectedOption = options.find((o) => o.value === value);
  const triggerSizeClass = compact
    ? "h-8 px-2.5 text-[13px]"
    : "h-10 px-3 text-[14px]";
  const optionSizeClass = searchable
    ? "px-3 py-2 text-[14px]"
    : compact
      ? "px-2.5 py-1.5 text-[13px]"
      : "px-3 py-2 text-[14px]";
  const searchInputSizeClass = compact ? "h-8 text-[13px]" : "h-10 text-[14px]";
  const normalizedKeyword = searchKeyword.trim().toLowerCase();
  const filteredOptions = !searchable || !normalizedKeyword
    ? options
    : options.filter((opt) => {
      const label = `${opt.label} ${opt.typeLabel || ""} ${opt.searchText || ""}`.toLowerCase();
      return label.includes(normalizedKeyword);
    });

  return (
    <div className="relative w-full min-w-0" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setSearchKeyword("");
          }
        }}
        className={`w-full min-w-0 flex items-center justify-between ${triggerSizeClass} bg-white dark:bg-[#1c1833] border rounded-[6px] transition-colors ${
          isWarning
            ? "border-[#ffb700] text-[#f5a623] hover:border-[#f5a623] focus:border-[#f5a623] focus:ring-1 focus:ring-[#f5a623]"
            : "border-[#dee0e3] text-[#1f2329] dark:border-gray-700 dark:text-gray-200 hover:border-[#3370ff] focus:border-[#3370ff]"
        } focus:outline-none focus:ring-0`}
      >
        <span className="min-w-0 flex-1 flex items-center gap-1.5 text-left">
          {selectedOption?.typeIcon ? (
            <span
              className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] bg-[#f5f6f7] text-[#8f959e] shrink-0"
              title={selectedOption.typeLabel || "字段"}
            >
              <FieldTypeIcon icon={selectedOption.typeIcon} className="w-[13px] h-[13px]" />
            </span>
          ) : null}
          <span className="truncate min-w-0">{selectedOption ? selectedOption.label : placeholder}</span>
        </span>
        <ChevronsUpDown className={`${compact ? "w-[16px] h-[16px]" : "w-[18px] h-[18px]"} text-[#8f959e] shrink-0 ml-2`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
          {searchable ? (
            <div className="px-2 border-b border-[#dee0e3] dark:border-gray-700">
              <input
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="搜索值或选择以下选项"
                className={`w-full ${searchInputSizeClass} px-0 border-0 bg-transparent shadow-none appearance-none outline-none focus:outline-none focus:ring-0 text-[#5f6670] dark:text-gray-200 placeholder-[#a3a9b3]`}
              />
            </div>
          ) : null}

          <div className={`${searchable ? "max-h-52 py-1" : "max-h-60 py-1"} overflow-y-auto`}>
            {filteredOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`w-full text-left ${optionSizeClass} transition-colors flex items-center justify-between ${
                  opt.value === value
                    ? "text-[#3370ff] bg-[#edf3ff] dark:bg-[#3370ff]/10 font-medium"
                    : "text-[#1f2329] dark:text-gray-300 hover:bg-[#f5f6f7] dark:hover:bg-gray-800"
                } focus:outline-none focus:ring-0`}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
              >
                <span className="min-w-0 flex items-center gap-1.5">
                  {opt.typeIcon ? (
                    <span
                      className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-[4px] bg-[#f5f6f7] text-[#8f959e] shrink-0"
                      title={opt.typeLabel || "字段"}
                    >
                      <FieldTypeIcon icon={opt.typeIcon} className="w-[12px] h-[12px]" />
                    </span>
                  ) : null}
                  <span className="truncate">{opt.label.replace(" / ", " · ")}</span>
                </span>
                {opt.value === value && (
                  <Check className={`${compact ? "w-[14px] h-[14px]" : "w-[16px] h-[16px]"}`} />
                )}
              </button>
            ))}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[#8f959e]">无可选字段</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

 // 2. Generic Standard Select (For Output Field)
function StandardSelect({
  value,
  onChange,
  options,
  searchable = false,
}: {
  value: string;
  onChange: (val: string) => void;
  options: SelectOption[];
  searchable?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setIsOpen(false));

  const selectedOption = options.find((o) => o.value === value);
  const normalizedKeyword = searchKeyword.trim().toLowerCase();
  const filteredOptions = !searchable || !normalizedKeyword
    ? options
    : options.filter((opt) => {
      const label = `${opt.label} ${opt.typeLabel || ""} ${opt.searchText || ""}`.toLowerCase();
      return label.includes(normalizedKeyword);
    });

  return (
    <div className="relative w-full min-w-0" ref={ref}>
        <button
          type="button"
          onClick={() => {
            setIsOpen(!isOpen);
            if (!isOpen) {
              setSearchKeyword("");
            }
          }}
          className="w-full min-w-0 h-10 flex items-center justify-between px-3 text-[14px] bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] text-[#1f2329] dark:text-gray-200 hover:border-[#3370ff] focus:border-[#3370ff] focus:outline-none focus:ring-0 transition-colors"
        >
          <span className="min-w-0 flex-1 flex items-center gap-1.5 text-left">
            {selectedOption?.typeIcon ? (
              <span
                className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] bg-[#f5f6f7] text-[#8f959e] shrink-0"
                title={selectedOption.typeLabel || "字段"}
              >
                <FieldTypeIcon icon={selectedOption.typeIcon} className="w-[13px] h-[13px]" />
              </span>
            ) : null}
            <span className="truncate min-w-0">{selectedOption?.label || "请选择"}</span>
          </span>
          <ChevronsUpDown className="w-[18px] h-[18px] text-[#8f959e] shrink-0 ml-2" />
        </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
          {searchable ? (
            <div className="px-2 border-b border-[#dee0e3] dark:border-gray-700">
              <input
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="搜索值或选择以下选项"
                className="w-full h-10 px-0 border-0 bg-transparent shadow-none appearance-none outline-none focus:outline-none focus:ring-0 text-[14px] text-[#5f6670] dark:text-gray-200 placeholder-[#a3a9b3]"
              />
            </div>
          ) : null}

          <div className={`${searchable ? "max-h-52 py-1" : "max-h-60 py-1"} overflow-y-auto`}>
            {filteredOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`w-full text-left ${searchable ? "px-3 py-2" : "px-3 py-2"} text-[14px] transition-colors flex items-center justify-between ${
                  opt.value === value
                    ? "text-[#3370ff] bg-[#edf3ff] dark:bg-[#3370ff]/10 font-medium"
                    : "text-[#1f2329] dark:text-gray-300 hover:bg-[#f5f6f7] dark:hover:bg-gray-800"
                } focus:outline-none focus:ring-0`}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
              >
                <span className="min-w-0 flex items-center gap-1.5">
                  {opt.typeIcon ? (
                    <span
                      className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-[4px] bg-[#f5f6f7] text-[#8f959e] shrink-0"
                      title={opt.typeLabel || "字段"}
                    >
                      <FieldTypeIcon icon={opt.typeIcon} className="w-[12px] h-[12px]" />
                    </span>
                  ) : null}
                  <span className="truncate">{opt.label}</span>
                </span>
                {opt.value === value && (
                  <Check className="w-[16px] h-[16px]" />
                )}
              </button>
            ))}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[#8f959e]">无可选字段</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
   );
 }

 // --- End Custom UI Components ---
export default function App() {
  const [table, setTable] = useState<ITable | null>(null);
  const [fields, setFields] = useState<FieldMetaLite[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);

  const [templateUrl, setTemplateUrl] = useState("");
  const [templateTitle, setTemplateTitle] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [bindings, setBindings] = useState<Record<string, string>>({});

  const [outputFieldId, setOutputFieldId] = useState("");
  const [titleFieldId, setTitleFieldId] = useState("");

  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState<GenerateProgressState>({
    visible: false,
    total: 0,
    completed: 0,
    phase: "",
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [results, setResults] = useState<GenerateApiResult[]>([]);

  // Auth state
  const [authSession, setAuthSession] = useState<AuthSession>({ user: null, isAuthenticated: false });
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplateItem[]>([]);
  const [savedTemplatesLoading, setSavedTemplatesLoading] = useState(false);
  const [selectedTemplateLoadingId, setSelectedTemplateLoadingId] = useState<string | null>(null);
  const [autoConfigLoading, setAutoConfigLoading] = useState(false);
  const [lastAutoLoadedTemplateId, setLastAutoLoadedTemplateId] = useState("");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  const [showUnboundModal, setShowUnboundModal] = useState(false);
  const [pendingGenerateMode, setPendingGenerateMode] = useState<GenerateMode | null>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep>("extract");

  const [allUsersCache, setAllUsersCache] = useState<OwnerCandidate[] | null>(null);

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [advancedSettings, setAdvancedSettings] = useState<AdvancedGenerationSettings>(
    DEFAULT_ADVANCED_GENERATION_SETTINGS,
  );
  const collabSearchTimers = useRef<Record<string, number>>({});
  const collabContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const autoSaveTimerRef = useRef<number | null>(null);
  const skipAutoSaveRef = useRef(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const [linkConfigs, setLinkConfigs] = useState<Record<string, LinkFieldConfig>>({});
  const [attachmentConfigs, setAttachmentConfigs] = useState<Record<string, AttachmentFieldConfig>>({});
  const [linkedTableFieldsCache, setLinkedTableFieldsCache] = useState<Record<string, FieldMetaLite[]>>({});
  const linkedTableFieldsCacheRef = useRef<Record<string, FieldMetaLite[]>>({});
  const linkedTableFieldsInflightRef = useRef<Record<string, Promise<FieldMetaLite[]>>>({});


  const outputFieldCandidates = useMemo(
    () => getOutputFieldCandidates(fields),
    [fields],
  );
  const hasUnboundVariables = useMemo(
    () => variables.some((variable) => !bindings[variable]),
    [variables, bindings],
  );
  const unboundVariableNames = useMemo(
    () => variables.filter((v) => !bindings[v]),
    [variables, bindings],
  );

  useEffect(() => {
    linkedTableFieldsCacheRef.current = linkedTableFieldsCache;
  }, [linkedTableFieldsCache]);

  const fetchLinkedTableFields = useCallback(async (tableId: string): Promise<FieldMetaLite[]> => {
    const cached = linkedTableFieldsCacheRef.current[tableId];
    if (cached) {
      return cached;
    }

    const inflight = linkedTableFieldsInflightRef.current[tableId];
    if (inflight) {
      return inflight;
    }

    const task = (async () => {
      try {
        const linkedTable = await bitable.base.getTableById(tableId);
        const fieldList = await getFieldMetaListSafe(linkedTable);
        setLinkedTableFieldsCache((prev) => {
          if (prev[tableId]) {
            return prev;
          }
          const next = { ...prev, [tableId]: fieldList };
          linkedTableFieldsCacheRef.current = next;
          return next;
        });
        return fieldList;
      } catch {
        return [];
      }
    })();

    linkedTableFieldsInflightRef.current[tableId] = task;
    return task.finally(() => {
      delete linkedTableFieldsInflightRef.current[tableId];
    });
  }, []);

  // Auth check on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch("/api/auth/session");
        if (response.ok) {
          const data = await response.json() as AuthSessionResponse;
          if (data.user) {
            setAuthSession({ user: data.user, isAuthenticated: true });
            if (data.sync && !data.sync.ok && data.sync.message) {
              setNotice({ type: "info", text: `${data.sync.message}（不影响继续使用）` });
            }
          } else {
            setAuthSession({ user: null, isAuthenticated: false });
          }
        } else {
          setAuthSession({ user: null, isAuthenticated: false });
        }
      } catch (error) {
        setAuthError(toErrorMessage(error));
        setAuthSession({ user: null, isAuthenticated: false });
      } finally {
        setAuthLoading(false);
      }
    };
    void checkAuth();
  }, []);

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setAuthSession({ user: null, isAuthenticated: false });
      setAuthError(null);
      setSavedTemplates([]);
      setTemplateUrl("");
      setTemplateTitle("");
      setVariables([]);
      setBindings({});
      setResults([]);
      setAccountMenuOpen(false);
    } catch (error) {
      setAuthError(toErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!authSession.isAuthenticated) {
      setCurrentStep("extract");
      setAccountMenuOpen(false);
      return;
    }
    if (!templateTitle) {
      setCurrentStep("extract");
      return;
    }
    setCurrentStep((prev) => (prev === "extract" ? "configure" : prev));
  }, [authSession.isAuthenticated, templateTitle]);

  const refreshSavedTemplates = useCallback(async () => {
    if (!authSession.isAuthenticated) {
      setSavedTemplates([]);
      return;
    }
    setSavedTemplatesLoading(true);
    try {
      const params = new URLSearchParams();
      if (table?.id) {
        params.set("tableId", table.id);
      }
      const response = await fetch(`/api/templates/saved${params.toString() ? `?${params.toString()}` : ""}`, { cache: "no-store" });
      const payload = await parseJsonResponse<SavedTemplatesResponse>(response);
      if (payload.sync && !payload.sync.ok && payload.sync.message) {
        setNotice({ type: "info", text: `${payload.sync.message}（不影响继续使用）` });
      }
      const templates = [...(payload.templates || [])].sort((a, b) => {
        const aTime = new Date(a.updatedAt).getTime();
        const bTime = new Date(b.updatedAt).getTime();
        if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
          return b.updatedAt.localeCompare(a.updatedAt);
        }
        return bTime - aTime;
      });
      setSavedTemplates(templates);
    } catch (error) {
      setNotice({
        type: "info",
        text: `历史记录拉取失败：${toErrorMessage(error)}（不影响继续使用）`,
      });
    } finally {
      setSavedTemplatesLoading(false);
    }
  }, [authSession.isAuthenticated, table?.id]);

  const applySavedPayload = useCallback((config: SavedConfigPayload) => {
    const normalizedBindings: Record<string, string> = {};
    const decodedLinkConfigs: Record<string, LinkFieldConfig> = {};

    if (config.bindings && typeof config.bindings === "object") {
      for (const [variable, rawValue] of Object.entries(config.bindings)) {
        const value = typeof rawValue === "string" ? rawValue.trim() : "";
        if (!value || value === UNBOUND_FIELD_VALUE) {
          normalizedBindings[variable] = "";
          continue;
        }

        if (!value.includes("::")) {
          normalizedBindings[variable] = value;
          continue;
        }

        const [fieldId, linkedFieldIdRaw] = value.split("::");
        normalizedBindings[variable] = fieldId || "";
        if (fieldId && linkedFieldIdRaw && linkedFieldIdRaw !== LINK_SUMMARY_VALUE) {
          decodedLinkConfigs[variable] = { linkedFieldId: linkedFieldIdRaw };
        } else if (fieldId) {
          decodedLinkConfigs[variable] = { linkedFieldId: "" };
        }
      }
    }

    const explicitLinkConfigs: Record<string, LinkFieldConfig> = {};
    if (config.linkConfigs && typeof config.linkConfigs === "object") {
      for (const [variable, raw] of Object.entries(config.linkConfigs)) {
        if (!raw || typeof raw !== "object") continue;
        const linkedFieldId = typeof (raw as LinkFieldConfig).linkedFieldId === "string"
          ? (raw as LinkFieldConfig).linkedFieldId
          : "";
        explicitLinkConfigs[variable] = { linkedFieldId };
      }
    }

    const mergedLinkConfigs = {
      ...decodedLinkConfigs,
      ...explicitLinkConfigs,
    };

    if (typeof config.templateUrl === "string") setTemplateUrl(config.templateUrl);
    if (typeof config.templateTitle === "string" && config.templateTitle.trim()) {
      setTemplateTitle(config.templateTitle);
    }
    setBindings(normalizedBindings);
    setLinkConfigs(mergedLinkConfigs);

    if (config.attachmentConfigs && typeof config.attachmentConfigs === "object") {
      setAttachmentConfigs(config.attachmentConfigs as Record<string, AttachmentFieldConfig>);
    } else {
      setAttachmentConfigs({});
    }
    if (typeof config.outputFieldId === "string") setOutputFieldId(config.outputFieldId);
    if (typeof config.titleFieldId === "string") setTitleFieldId(config.titleFieldId);
    if (Array.isArray(config.collaborators)) {
      setCollaborators(
        config.collaborators.map((item) => ({
          id: `collab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          user: item.user ?? null,
          role:
            item.role === "view" || item.role === "edit" || item.role === "full_access"
              ? item.role
              : "view",
          keyword: item.user ? formatOwnerLabel(item.user) : "",
          candidates: [],
          searchOpen: false,
          searchLoading: false,
          roleOpen: false,
        })),
      );
    }

    if (config.advancedGeneration && typeof config.advancedGeneration === "object") {
      const raw = config.advancedGeneration;
      setAdvancedSettings({
        ownerTransferEnabled:
          typeof raw.ownerTransferEnabled === "boolean"
            ? raw.ownerTransferEnabled
            : DEFAULT_ADVANCED_GENERATION_SETTINGS.ownerTransferEnabled,
        ownerTransferNeedNotification:
          typeof raw.ownerTransferNeedNotification === "boolean"
            ? raw.ownerTransferNeedNotification
            : DEFAULT_ADVANCED_GENERATION_SETTINGS.ownerTransferNeedNotification,
        ownerTransferRemoveOldOwner:
          typeof raw.ownerTransferRemoveOldOwner === "boolean"
            ? raw.ownerTransferRemoveOldOwner
            : DEFAULT_ADVANCED_GENERATION_SETTINGS.ownerTransferRemoveOldOwner,
        ownerTransferStayPut:
          typeof raw.ownerTransferStayPut === "boolean"
            ? raw.ownerTransferStayPut
            : DEFAULT_ADVANCED_GENERATION_SETTINGS.ownerTransferStayPut,
        ownerTransferOldOwnerPerm:
          raw.ownerTransferOldOwnerPerm === "view" ||
          raw.ownerTransferOldOwnerPerm === "edit" ||
          raw.ownerTransferOldOwnerPerm === "full_access"
            ? raw.ownerTransferOldOwnerPerm
            : DEFAULT_ADVANCED_GENERATION_SETTINGS.ownerTransferOldOwnerPerm,
      });
    } else {
      setAdvancedSettings(DEFAULT_ADVANCED_GENERATION_SETTINGS);
    }
  }, []);

  const handleLoadSavedConfig = useCallback(async (configId: string, options?: { silentNotice?: boolean }) => {
    if (!authSession.isAuthenticated) return false;
    try {
      skipAutoSaveRef.current = true;
      const params = new URLSearchParams();
      if (table?.id) {
        params.set("tableId", table.id);
      }
      const response = await fetch(`/api/configs/${configId}${params.toString() ? `?${params.toString()}` : ""}`, { cache: "no-store" });
      const payload = await parseJsonResponse<SavedConfigDetailResponse>(response);
      applySavedPayload(payload.config?.payload ?? {});
      setCurrentStep("configure");

      if (!options?.silentNotice) {
        setNotice({ type: "success", text: `模板「${payload.config.configName.replace(/^template::/, "") || payload.config.configName}」已加载。` });
      }
      return true;
    } catch (error) {
      setNotice({ type: "error", text: `读取模板配置失败：${toErrorMessage(error)}` });
      return false;
    } finally {
      window.setTimeout(() => {
        skipAutoSaveRef.current = false;
      }, 1200);
    }
  }, [authSession.isAuthenticated, applySavedPayload, table?.id]);

  useEffect(() => {
    if (!authSession.isAuthenticated) {
      setSavedTemplates([]);
      return;
    }
    void refreshSavedTemplates();
  }, [authSession.isAuthenticated, refreshSavedTemplates]);

  useEffect(() => {
    if (!authSession.isAuthenticated) return;
    if (selectedTemplateLoadingId !== null) return;
    const docId = extractDocumentIdFromUrl(templateUrl);
    if (!docId || docId === lastAutoLoadedTemplateId) return;

    const load = async () => {
      setAutoConfigLoading(true);
      try {
        const params = new URLSearchParams({ templateUrl: templateUrl.trim() });
        if (table?.id) {
          params.set("tableId", table.id);
        }
        const query = params.toString();
        const response = await fetch(`/api/configs/auto?${query}`, { cache: "no-store" });
        const payload = await parseJsonResponse<AutoConfigResponse>(response);
        if (payload.found && payload.config) {
          applySavedPayload(payload.config.payload);
        }
        if (payload.sync && !payload.sync.ok && payload.sync.message) {
          setNotice({ type: "info", text: `${payload.sync.message}（不影响继续使用）` });
        }
      } catch (error) {
        setNotice({ type: "info", text: `自动读取历史配置失败：${toErrorMessage(error)}（不影响继续使用）` });
      } finally {
        setLastAutoLoadedTemplateId(docId);
        setAutoConfigLoading(false);
      }
    };

    void load();
  }, [authSession.isAuthenticated, templateUrl, lastAutoLoadedTemplateId, applySavedPayload, selectedTemplateLoadingId, table?.id]);

  useEffect(() => {
    if (!authSession.isAuthenticated) return;
    const docId = extractDocumentIdFromUrl(templateUrl);
    if (!docId) return;
    if (skipAutoSaveRef.current) return;
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        const response = await fetch("/api/configs/auto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateUrl: templateUrl.trim(),
            tableId: table?.id || "",
            payload: {
              tableId: table?.id || "",
              templateUrl,
              templateTitle,
              bindings,
              linkConfigs,
              attachmentConfigs,
              outputFieldId,
              titleFieldId,
              collaborators: collaborators.map((item) => ({ user: item.user, role: item.role })),
              advancedGeneration: advancedSettings,
            },
          }),
        });
        const payload = await parseJsonResponse<{ ok: true; config: { id: string; updatedAt: string } | null; sync?: SyncStatusInfo }>(response);
        if (!payload.config) {
          if (payload.sync && !payload.sync.ok && payload.sync.message) {
            setNotice({ type: "info", text: `${payload.sync.message}（不影响继续使用）` });
          }
          return;
        }
        const savedConfig = payload.config;
        setSavedTemplates((prev) => {
          const existing = prev.find((t) => t.id === savedConfig.id);
          if (existing) {
            return prev.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    templateTitle: templateTitle || existing.templateTitle,
                    templateUrl,
                    updatedAt: savedConfig.updatedAt,
                  }
                : item,
            );
          }
          return [
            {
              id: savedConfig.id,
              templateId: docId,
              templateTitle: templateTitle || `模板 ${docId.slice(0, 8)}`,
              templateUrl,
              createdAt: savedConfig.updatedAt,
              updatedAt: savedConfig.updatedAt,
            },
            ...prev,
          ];
        });
      })();
    }, 900);

    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
  }, [authSession.isAuthenticated, templateUrl, templateTitle, bindings, linkConfigs, attachmentConfigs, outputFieldId, titleFieldId, collaborators, advancedSettings, table?.id]);

  const loadAllUsers = useCallback(async (): Promise<OwnerCandidate[]> => {
    if (allUsersCache !== null) return allUsersCache;
    try {
      const response = await fetch(
        `/api/users/search?q=&limit=200&_ts=${Date.now()}`,
        { cache: "no-store" },
      );
      const payload = await parseJsonResponse<OwnerSearchResponse>(response);
      setAllUsersCache(payload.users);
      return payload.users;
    } catch {
      return [];
    }
  }, [allUsersCache]);

  const addCollaborator = useCallback(() => {
    setCollaborators((prev) => [
      ...prev,
      {
        id: `collab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        user: null,
        role: "view",
        keyword: "",
        candidates: [],
        searchOpen: false,
        searchLoading: false,
        roleOpen: false,
      },
    ]);
  }, []);

  const removeCollaborator = useCallback((id: string) => {
    setCollaborators((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const updateCollaborator = useCallback((id: string, updates: Partial<Collaborator>) => {
    setCollaborators((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    );
  }, []);

  const searchCollaboratorUsers = useCallback(async (id: string, keyword: string) => {
    const trimmed = keyword.trim();
    updateCollaborator(id, { searchLoading: true });
    try {
      let users: OwnerCandidate[];
      if (allUsersCache !== null) {
        users = allUsersCache;
      } else {
        users = await loadAllUsers();
      }
      if (!trimmed) {
        // Empty keyword: show all users
        updateCollaborator(id, {
          candidates: users.slice(0, 50),
          searchOpen: true,
          searchLoading: false,
        });
        return;
      }
      const lower = trimmed.toLowerCase();
      const filtered = users.filter((u) => {
        const name = (u.name || "").toLowerCase();
        const nickname = (u.nickname || "").toLowerCase();
        const enName = (u.enName || "").toLowerCase();
        return name.includes(lower) || nickname.includes(lower) || enName.includes(lower);
      });
      updateCollaborator(id, {
        candidates: filtered.slice(0, 20),
        searchOpen: true,
        searchLoading: false,
      });
    } catch {
      updateCollaborator(id, { candidates: [], searchOpen: true, searchLoading: false });
    }
  }, [allUsersCache, loadAllUsers, updateCollaborator]);

  const handleBindingChange = useCallback((variable: string, fieldId: string) => {
    const resolvedId = fieldId === UNBOUND_FIELD_VALUE ? "" : fieldId;
    setBindings((prev) => ({ ...prev, [variable]: resolvedId }));

    if (!resolvedId) {
      setLinkConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
      setAttachmentConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
      return;
    }

    const field = fields.find((f) => f.id === resolvedId);
    if (!field) return;

    if (LINK_FIELD_TYPES.has(field.type as FieldType) && field.property?.tableId) {
      setLinkConfigs((prev) => ({
        ...prev,
        [variable]: { linkedFieldId: "" },
      }));
      setAttachmentConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
      void fetchLinkedTableFields(field.property.tableId);
    } else if (field.type === ATTACHMENT_FIELD_TYPE) {
      setAttachmentConfigs((prev) => ({
        ...prev,
        [variable]: { imageWidth: DEFAULT_IMAGE_WIDTH, widthMode: "preset" },
      }));
      setLinkConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
    } else {
      setLinkConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
      setAttachmentConfigs((prev) => { const next = { ...prev }; delete next[variable]; return next; });
    }
  }, [fields, fetchLinkedTableFields]);

  const refreshTableContext = useCallback(async () => {
    setIsLoadingContext(true);
    try {
      let selection: { tableId?: string | null } | null = null;
      try {
        selection = await bitable.base.getSelection();
      } catch {
        selection = null;
      }
      let activeTable: ITable | null = null;

      if (selection?.tableId) {
        try {
          activeTable = await bitable.base.getTableById(selection.tableId);
        } catch {
          activeTable = null;
        }
      }

      if (!activeTable) {
        try {
          activeTable = await bitable.base.getActiveTable();
        } catch {
          activeTable = null;
        }
      }

      if (!activeTable) {
        const tableList = await bitable.base.getTableList();
        activeTable = tableList[0] ?? null;
      }

      if (!activeTable) {
        throw new Error("未获取到当前数据表。");
      }

      let fieldMetaList = await getFieldMetaListSafe(activeTable);
      if (fieldMetaList.length === 0) {
        const tableList = await bitable.base.getTableList();
        for (const candidate of tableList) {
          const candidateFields = await getFieldMetaListSafe(candidate);
          if (candidateFields.length > 0) {
            activeTable = candidate;
            fieldMetaList = candidateFields;
            break;
          }
        }
      }

      const selectedIds = await getSelectedRecordIds(activeTable);
      setTable(activeTable);
      setFields(fieldMetaList);
      setSelectedRecordIds(selectedIds);
      setNotice((previous) => (previous?.type === "error" ? null : previous));
    } finally {
      setIsLoadingContext(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unbindSelection: (() => void) | undefined;

    const initialize = async () => {
      try {
        await refreshTableContext();
        if (!disposed) {
          unbindSelection = bitable.base.onSelectionChange(() => {
            void refreshTableContext();
          });
        }
      } catch (error) {
        setNotice({
          type: "error",
          text: `无法初始化边栏环境，请在飞书多维表格边栏中运行：${toErrorMessage(error)}`,
        });
      }
    };

    void initialize();
    return () => {
      disposed = true;
      unbindSelection?.();
    };
  }, [refreshTableContext]);

  useEffect(() => {
    if (!variables.length || !fields.length) {
      return;
    }
    setBindings((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const variable of variables) {
        const boundFieldId = next[variable];
        if (boundFieldId && fields.some((field) => field.id === boundFieldId)) {
          continue;
        }
        const matched = findBestMatchedField(variable, fields);
        if (matched?.id) {
          next[variable] = matched.id;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [variables, fields]);

  useEffect(() => {
    if (!variables.length || !fields.length) return;

    setLinkConfigs((prevLink) => {
      const next = { ...prevLink };
      let changed = false;
      for (const variable of variables) {
        const fieldId = bindings[variable];
        if (!fieldId) {
          if (next[variable]) { delete next[variable]; changed = true; }
          continue;
        }
        const field = fields.find((f) => f.id === fieldId);
        if (field && LINK_FIELD_TYPES.has(field.type as FieldType) && field.property?.tableId) {
          if (!next[variable]) { next[variable] = { linkedFieldId: "" }; changed = true; }
          void fetchLinkedTableFields(field.property.tableId);
        } else if (next[variable]) {
          delete next[variable]; changed = true;
        }
      }
      return changed ? next : prevLink;
    });

    setAttachmentConfigs((prevAttach) => {
      const next = { ...prevAttach };
      let changed = false;
      for (const variable of variables) {
        const fieldId = bindings[variable];
        if (!fieldId) {
          if (next[variable]) { delete next[variable]; changed = true; }
          continue;
        }
        const field = fields.find((f) => f.id === fieldId);
        if (field?.type === ATTACHMENT_FIELD_TYPE) {
          if (!next[variable]) { next[variable] = { imageWidth: DEFAULT_IMAGE_WIDTH, widthMode: "preset" }; changed = true; }
          continue;
        }

        const linkConfig = linkConfigs[variable];
        const linkedTableId = field && LINK_FIELD_TYPES.has(field.type as FieldType) ? field.property?.tableId : undefined;
        const linkedFieldMeta = linkedTableId && linkConfig?.linkedFieldId
          ? linkedTableFieldsCache[linkedTableId]?.find((f) => f.id === linkConfig.linkedFieldId)
          : undefined;
        const usesLinkedAttachment = linkedFieldMeta?.type === ATTACHMENT_FIELD_TYPE;

        if (usesLinkedAttachment) {
          if (!next[variable]) { next[variable] = { imageWidth: DEFAULT_IMAGE_WIDTH, widthMode: "preset" }; changed = true; }
        } else if (next[variable]) {
          delete next[variable]; changed = true;
        }
      }
      return changed ? next : prevAttach;
    });
  }, [variables, fields, bindings, fetchLinkedTableFields, linkConfigs, linkedTableFieldsCache]);

  useEffect(() => {
    const linkFields = fields.filter(
      (f) => LINK_FIELD_TYPES.has(f.type as FieldType) && f.property?.tableId,
    );
    for (const field of linkFields) {
      if (field.property?.tableId) {
        void fetchLinkedTableFields(field.property.tableId);
      }
    }
  }, [fields, fetchLinkedTableFields]);

  useEffect(() => {
    if (outputFieldId && !fields.some((field) => field.id === outputFieldId)) {
      setOutputFieldId("");
    }
  }, [fields, outputFieldId]);

  useEffect(() => {
    if (titleFieldId && !fields.some((field) => field.id === titleFieldId)) {
      setTitleFieldId("");
    }
  }, [fields, titleFieldId]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      setCollaborators((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          if (!c.searchOpen && !c.roleOpen) return c;
          const container = collabContainerRefs.current[c.id];
          if (container && !container.contains(target)) {
            changed = true;
            return { ...c, searchOpen: false, roleOpen: false };
          }
          return c;
        });
        return changed ? next : prev;
      });
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountMenuRef.current && !accountMenuRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [accountMenuOpen]);

  const extractVariablesByTemplateUrl = useCallback(async (sourceTemplateUrl: string) => {
    const trimmed = sourceTemplateUrl.trim();
    if (!trimmed) {
      throw new Error("请先填写模板文档链接。");
    }
    const response = await fetch("/api/template/variables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateUrl: trimmed }),
    });
    const payload = await parseJsonResponse<TemplateVariablesResponse>(response);
    setTemplateUrl(trimmed);
    setVariables(payload.variables);
    setTemplateTitle(payload.templateTitle);
    const nextBindings = autoBindVariables(payload.variables, fields);
    setBindings(nextBindings);
    setCurrentStep("configure");

    if (!outputFieldId) {
      const existedOutput = outputFieldCandidates.find(
        (field) => field.name === OUTPUT_FIELD_BASE_NAME,
      );
      if (existedOutput) {
        setOutputFieldId(existedOutput.id);
      }
    }
    return payload;
  }, [fields, outputFieldId, outputFieldCandidates]);

  const handleExtractVariables = useCallback(async () => {
    setIsExtracting(true);
    try {
      await extractVariablesByTemplateUrl(templateUrl);
      setNotice(null);
    } catch (error) {
      setNotice({
        type: "error",
        text: `提取变量失败：${toErrorMessage(error)}`,
      });
    } finally {
      setIsExtracting(false);
    }
  }, [templateUrl, extractVariablesByTemplateUrl]);

  const handleSelectSavedTemplate = useCallback(async (item: SavedTemplateItem) => {
    if (!item.templateUrl) {
      setNotice({ type: "error", text: "该模板缺少链接，暂时无法自动加载。" });
      return;
    }

    const docId = extractDocumentIdFromUrl(item.templateUrl);
    setSelectedTemplateLoadingId(item.id);
    setIsExtracting(true);
    skipAutoSaveRef.current = true;
    try {
      await extractVariablesByTemplateUrl(item.templateUrl);
      const loaded = await handleLoadSavedConfig(item.id, { silentNotice: true });
      void loaded;
      if (docId) {
        setLastAutoLoadedTemplateId(docId);
      }
      setCurrentStep("configure");
    } catch (error) {
      setNotice({ type: "error", text: `模板加载失败：${toErrorMessage(error)}` });
    } finally {
      setIsExtracting(false);
      setSelectedTemplateLoadingId(null);
      window.setTimeout(() => {
        skipAutoSaveRef.current = false;
      }, 1200);
    }
  }, [extractVariablesByTemplateUrl, handleLoadSavedConfig]);

  const ensureOutputField = useCallback(async (): Promise<FieldMetaLite> => {
    if (!table) {
      throw new Error("当前数据表未就绪，请稍后重试。");
    }
    const existed = fields.find((field) => field.id === outputFieldId);
    if (existed) {
      return existed;
    }
    const fieldName = getUniqueOutputFieldName(fields);
    const fieldId = await table.addField({
      type: FieldType.Url,
      name: fieldName,
    });
    const latestFields = await getFieldMetaListSafe(table);
    setFields(latestFields);
    setOutputFieldId(fieldId);
    const created = latestFields.find((field) => field.id === fieldId);
    if (!created) {
      throw new Error("输出字段创建成功，但读取字段信息失败。");
    }
    return created;
  }, [table, fields, outputFieldId]);

  const collectVariablesForRecords = useCallback(
    async (
      recordIds: string[],
      titleField: string | undefined,
      onProgress?: (done: number, total: number) => void,
    ): Promise<
      Array<{
        recordId: string;
        variables: Record<string, string>;
        imageVariables?: Record<string, ImageVariablePayload>;
        title?: string;
      }>
    > => {
      if (!table) {
        throw new Error("当前数据表未就绪。");
      }
      const records: Array<{
        recordId: string;
        variables: Record<string, string>;
        imageVariables?: Record<string, ImageVariablePayload>;
        title?: string;
      }> = [];
      const total = recordIds.length;

      for (let index = 0; index < recordIds.length; index += 1) {
        const recordId = recordIds[index];
        const textVars: Record<string, string> = {};
        const imageVars: Record<string, ImageVariablePayload> = {};

        await Promise.all(
          variables.map(async (variable) => {
            const fieldId = bindings[variable];
            if (!fieldId) return;

            const field = fields.find((f) => f.id === fieldId);
            if (!field) return;

            try {
              if (LINK_FIELD_TYPES.has(field.type as FieldType)) {
                const linkConfig = linkConfigs[variable];
                const cellValue = await table.getCellValue(fieldId, recordId);
                const link = cellValue as { recordIds?: string[]; tableId?: string; text?: string } | null;

                if (!link?.recordIds?.length || !link.tableId) {
                  textVars[variable] = link?.text || "";
                  return;
                }

                if (!linkConfig?.linkedFieldId) {
                  textVars[variable] = link.text || "";
                  return;
                }

                const linkedFieldsList = linkedTableFieldsCache[link.tableId] ?? await fetchLinkedTableFields(link.tableId);
                const linkedFieldMeta = linkedFieldsList?.find((f) => f.id === linkConfig.linkedFieldId);
                const isLinkedFieldAttachment = linkedFieldMeta?.type === ATTACHMENT_FIELD_TYPE;
                const linkedTable = await bitable.base.getTableById(link.tableId);

                if (isLinkedFieldAttachment) {
                  const allImageUrls: string[] = [];

                  for (const rid of link.recordIds) {
                    try {
                      const attachValue = await linkedTable.getCellValue(linkConfig.linkedFieldId, rid);
                      const attachments = attachValue as Array<{ token: string; type: string }> | null;
                      if (attachments?.length) {
                        const imageAttachments = attachments.filter((a) => a.type?.startsWith("image/"));
                        if (imageAttachments.length > 0) {
                          const tokens = imageAttachments.map((a) => a.token);
                          const urls = await linkedTable.getCellAttachmentUrls(tokens, linkConfig.linkedFieldId, rid);
                          allImageUrls.push(...urls.filter(Boolean));
                        }
                      }
                    } catch {}
                  }

                  if (allImageUrls.length > 0) {
                    const attachConfig = attachmentConfigs[variable];
                    imageVars[variable] = {
                      urls: allImageUrls,
                      width: attachConfig?.imageWidth || DEFAULT_IMAGE_WIDTH,
                    };
                  } else {
                    textVars[variable] = "";
                  }
                } else {
                  const values: string[] = [];
                  for (const rid of link.recordIds) {
                    try {
                      const v = await linkedTable.getCellString(linkConfig.linkedFieldId, rid);
                      if (v) values.push(v);
                    } catch {}
                  }
                  textVars[variable] = values.join("、");
                }

              } else if (field.type === ATTACHMENT_FIELD_TYPE) {
                const attachConfig = attachmentConfigs[variable];
                const cellValue = await table.getCellValue(fieldId, recordId);
                const attachments = cellValue as Array<{ token: string; name: string; type: string }> | null;

                if (!attachments?.length) {
                  textVars[variable] = "";
                  return;
                }

                const imageAttachments = attachments.filter((a) =>
                  a.type?.startsWith("image/"),
                );

                if (imageAttachments.length === 0) {
                  textVars[variable] = attachments.map((a) => a.name).join(", ");
                  return;
                }

                const tokens = imageAttachments.map((a) => a.token);
                const urls = await table.getCellAttachmentUrls(tokens, fieldId, recordId);

                imageVars[variable] = {
                  urls: urls.filter(Boolean),
                  width: attachConfig?.imageWidth || DEFAULT_IMAGE_WIDTH,
                };

              } else {
                const value = await table.getCellString(fieldId, recordId);
                textVars[variable] = value || "";
              }
            } catch {
              textVars[variable] = "";
            }
          }),
        );

        const entry: {
          recordId: string;
          variables: Record<string, string>;
          imageVariables?: Record<string, ImageVariablePayload>;
          title?: string;
        } = { recordId, variables: textVars };

        if (Object.keys(imageVars).length > 0) {
          entry.imageVariables = imageVars;
        }

        if (titleField) {
          try {
            const titleValue = await table.getCellString(titleField, recordId);
            if (titleValue?.trim()) {
              entry.title = titleValue.trim();
            }
          } catch {}
        }

        records.push(entry);
        if (onProgress) {
          onProgress(index + 1, total);
        }
      }
      return records;
    },
    [table, variables, bindings, fields, linkConfigs, attachmentConfigs, linkedTableFieldsCache, fetchLinkedTableFields],
  );

  const executeGenerate = useCallback(
    async (generateMode: GenerateMode) => {
      if (!table) {
        setNotice({ type: "error", text: "当前表尚未就绪，请稍后重试。" });
        return;
      }
      if (!templateUrl.trim()) {
        setNotice({ type: "error", text: "请先填写模板文档链接。" });
        return;
      }
      if (!templateTitle) {
        setNotice({ type: "error", text: "请先提取模板变量。" });
        return;
      }

      let targetRecordIds: string[] = [];
      if (generateMode === "selected") {
        targetRecordIds = [...selectedRecordIds];
      } else {
        targetRecordIds = await getAllRecordIds(table);
      }
      if (targetRecordIds.length === 0) {
        setNotice({
          type: "error",
          text:
            generateMode === "selected"
              ? "未检测到选中记录。"
              : "当前表没有可处理的记录。",
        });
        return;
      }

      setIsGenerating(true);
      setGenerateProgress({
        visible: true,
        total: targetRecordIds.length,
        completed: 0,
        phase: "正在读取记录...",
      });
      try {
        const outputField = await ensureOutputField();
        const records = await collectVariablesForRecords(
          targetRecordIds,
          titleFieldId || undefined,
          (done, total) => {
            const prepCap = Math.max(1, Math.floor(total * 0.45));
            const progressCount = Math.max(0, Math.min(total, Math.floor((done / Math.max(1, total)) * prepCap)));
            setGenerateProgress({
              visible: true,
              total,
              completed: progressCount,
              phase: "正在准备变量...",
            });
          },
        );
        const ownerTransfer = authSession.user?.openId && advancedSettings.ownerTransferEnabled
          ? {
              memberType: "openid" as const,
              memberId: authSession.user.openId,
              needNotification: advancedSettings.ownerTransferNeedNotification,
              removeOldOwner: advancedSettings.ownerTransferRemoveOldOwner,
              stayPut: advancedSettings.ownerTransferStayPut,
              oldOwnerPerm: advancedSettings.ownerTransferOldOwnerPerm,
            }
          : undefined;

        const collaboratorPayload = collaborators
          .filter((c) => c.user !== null)
          .map((c) => ({
            memberType: "openid" as const,
            memberId: c.user!.openId,
            perm: c.role,
          }));

        const response = await fetch("/api/documents/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateUrl: templateUrl.trim(),
            records,
            options: {
              permissionMode: "internet_readable",
              ownerTransfer,
              collaborators: collaboratorPayload.length > 0 ? collaboratorPayload : undefined,
            },
          }),
        });
        setGenerateProgress((prev) => ({
          ...prev,
          phase: "云端生成中...",
          completed: Math.max(prev.completed, Math.floor(targetRecordIds.length * 0.6)),
        }));
        const payload = await parseJsonResponse<GenerateResponse>(response);

        const writeBackResults: GenerateApiResult[] = [];
        for (let index = 0; index < payload.results.length; index += 1) {
          const item = payload.results[index];
          if (item.status === "success" && item.docUrl) {
            try {
              const cellValue = buildWriteBackValue(item.docUrl);
              await table.setCellValue(
                outputField.id,
                item.recordId,
                cellValue,
              );
              writeBackResults.push(item);
            } catch (error) {
              writeBackResults.push({
                ...item,
                status: "failed",
                error: `文档已生成，但写回输出列失败：${toErrorMessage(error)}`,
              });
            }
          } else {
            writeBackResults.push(item);
          }

          setGenerateProgress({
            visible: true,
            total: targetRecordIds.length,
            completed: Math.max(1, Math.min(targetRecordIds.length, Math.floor(targetRecordIds.length * 0.6) + index + 1)),
            phase: "正在写回结果...",
          });
        }

        setResults(writeBackResults);
        const successCount = writeBackResults.filter(
          (item) => item.status === "success",
        ).length;
        setNotice({
          type: successCount > 0 ? "success" : "error",
          text: `已完成：成功 ${successCount} 条，失败 ${writeBackResults.length - successCount} 条。`,
        });
        await refreshTableContext();
      } catch (error) {
        setNotice({
          type: "error",
          text: `生成失败：${toErrorMessage(error)}`,
        });
      } finally {
        setIsGenerating(false);
        setGenerateProgress((prev) => ({
          ...prev,
          completed: prev.total,
          phase: prev.total > 0 ? "已完成" : prev.phase,
        }));
        window.setTimeout(() => {
          setGenerateProgress({ visible: false, total: 0, completed: 0, phase: "" });
        }, 800);
      }
    },
    [
      table,
      templateUrl,
      templateTitle,
      selectedRecordIds,
      ensureOutputField,
      collectVariablesForRecords,
      authSession.user?.openId,
      refreshTableContext,
      titleFieldId,
      collaborators,
      advancedSettings,
    ],
  );

  const handleGenerate = useCallback(
    (generateMode: GenerateMode) => {
      if (!table) {
        setNotice({ type: "error", text: "当前表尚未就绪，请稍后重试。" });
        return;
      }
      if (!templateUrl.trim()) {
        setNotice({ type: "error", text: "请先填写模板文档链接。" });
        return;
      }
      if (!templateTitle) {
        setNotice({ type: "error", text: "请先提取模板变量。" });
        return;
      }
      if (hasUnboundVariables) {
        setPendingGenerateMode(generateMode);
        setShowUnboundModal(true);
        return;
      }
      void executeGenerate(generateMode);
    },
    [table, templateUrl, templateTitle, hasUnboundVariables, executeGenerate],
  );

  const handleContinueToGenerate = useCallback(() => {
    if (!templateTitle) {
      setNotice({ type: "error", text: "请先提取模板变量。" });
      setCurrentStep("extract");
      return;
    }
    setCurrentStep("generate");
  }, [templateTitle]);

  const handleBackToConfig = useCallback(() => {
    setCurrentStep("configure");
  }, []);

  const outputOptions = useMemo(
    () => [
      { value: AUTO_OUTPUT_FIELD_VALUE, label: "+ 新建字段" },
      ...outputFieldCandidates.map((field) => {
        const visual = getFieldTypeVisual(field.type);
        return {
          value: field.id,
          label: field.name,
          typeIcon: visual.icon,
          typeLabel: visual.label,
        };
      }),
    ],
    [outputFieldCandidates],
  );

  const titleFieldOptions = useMemo(
    () => [
      { value: AUTO_TITLE_FIELD_VALUE, label: "使用模板名称 (默认)" },
      ...fields.map((f) => {
        const visual = getFieldTypeVisual(f.type);
        return {
          value: f.id,
          label: f.name,
          typeIcon: visual.icon,
          typeLabel: visual.label,
        };
      }),
    ],
    [fields],
  );

  const accountName = authSession.user?.name || "已登录用户";
  const accountAvatarText = useMemo(() => {
    const raw = authSession.user?.name?.trim() || "U";
    return raw.slice(0, 1).toUpperCase();
  }, [authSession.user]);
  const accountAvatarColor = useMemo(() => {
    const source = authSession.user?.openId || accountName;
    let hash = 0;
    for (let i = 0; i < source.length; i += 1) {
      hash = source.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 42%)`;
  }, [authSession.user?.openId, accountName]);

  const isOpeningSavedTemplate = Boolean(selectedTemplateLoadingId && isExtracting);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#131022] text-[#1f2329] dark:text-gray-100 flex items-center justify-center px-6">
        <div className="w-full max-w-md rounded-2xl border border-[#dee0e3] dark:border-gray-800 bg-white dark:bg-[#1c1833] p-6 text-center">
          <Loader2 className="w-7 h-7 mx-auto mb-3 text-[#3370ff] icon-spin-smooth" />
          <p className="text-[14px] text-[#8f959e]">正在检查登录状态...</p>
        </div>
      </div>
    );
  }

  if (!authSession.isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#f5f6f7] dark:bg-[#131022] text-[#1f2329] dark:text-gray-100 flex items-center justify-center px-5">
        <div className="w-full max-w-sm">
          {authError ? (
            <div className="mb-3 rounded-[10px] bg-[#fff1f0] text-[#f54a45] px-3 py-2 text-[13px] border border-[#ffd6d3]">
              登录检查失败：{authError}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/feishu/login";
            }}
            className="w-full h-12 rounded-full border border-[#d8dce3] bg-white dark:bg-[#1c1833] dark:border-gray-700 text-[#1f2329] dark:text-gray-100 text-[16px] font-medium hover:bg-[#fbfcfe] dark:hover:bg-[#232033] transition-colors flex items-center justify-center gap-2"
          >
            <FeishuMark className="w-5 h-5" />
            <span>飞书登录</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-white dark:bg-[#131022] font-sans text-[#1f2329] dark:text-gray-100 max-w-3xl mx-auto w-full">
      {/* 极简头部 */}
      <header className="sticky top-0 z-30 px-5 py-4 bg-white/95 dark:bg-[#131022]/95 backdrop-blur-md border-b border-[#dee0e3]/60 dark:border-gray-800">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-[#1f2329] dark:text-white">
              批量文档生成
            </h1>
            <p className="text-[13px] text-[#8f959e] mt-0.5">
              将表格数据填充至文档模板
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <div className="relative" ref={accountMenuRef}>
              <button
                type="button"
                onClick={() => setAccountMenuOpen((prev) => !prev)}
                className="h-9 pl-1.5 pr-2 inline-flex items-center gap-2 rounded-full border border-[#dee0e3] dark:border-gray-700 bg-white dark:bg-[#1c1833] hover:border-[#bfd0ff] transition-colors"
              >
                {authSession.user?.avatarUrl ? (
                  <img src={authSession.user.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover bg-gray-100" />
                ) : (
                  <span
                    className="w-7 h-7 rounded-full text-white text-[12px] font-semibold flex items-center justify-center"
                    style={{ backgroundColor: accountAvatarColor }}
                  >
                    {accountAvatarText}
                  </span>
                )}
                <span className="max-w-[96px] truncate text-[12px] font-medium text-[#1f2329] dark:text-gray-200">{accountName}</span>
                <ChevronDown className={`w-[14px] h-[14px] text-[#8f959e] transition-transform ${accountMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {accountMenuOpen ? (
                <div className="absolute right-0 top-[calc(100%+8px)] w-[180px] bg-white dark:bg-[#1c1833] border border-[#dfe2e6] dark:border-gray-700 rounded-[10px] shadow-[0_10px_24px_rgba(0,0,0,0.12)] overflow-hidden z-40">
                  <button
                    type="button"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      void handleLogout();
                    }}
                    className="w-full px-4 py-3 text-left text-[15px] font-medium text-[#f54a45] hover:bg-[#fff4f4] dark:hover:bg-red-900/20"
                  >
                    退出登录
                  </button>
                </div>
              ) : null}
            </div>
            {authError ? <span className="text-[#f54a45]" title={authError}>⚠️</span> : null}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full flex flex-col relative">
        {isOpeningSavedTemplate ? (
          <div className="absolute inset-0 z-40 bg-white/55 dark:bg-[#131022]/55 backdrop-blur-[2px] flex items-start justify-center pt-24">
            <div className="px-4 py-2 rounded-[10px] bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 text-[13px] text-[#5f6670] dark:text-gray-300 flex items-center gap-2 shadow-sm">
              <Loader2 className="w-[15px] h-[15px] text-[#3370ff] icon-spin-smooth" />
              <span>正在恢复历史配置...</span>
            </div>
          </div>
        ) : null}
        {/* 全局通知 */}
        {notice && (
          <div
            className={`mx-5 mt-5 flex items-start gap-2 p-3 text-[13px] rounded-[8px] transition-all ${
              notice.type === "error"
                ? "bg-[#fff1f0] text-[#f54a45] dark:bg-red-900/20 dark:text-red-400"
                : notice.type === "success"
                  ? "bg-[#f5f6f7] text-[#1f2329] border border-[#dee0e3] dark:bg-gray-800/40 dark:text-gray-200 dark:border-gray-700"
                  : "bg-[#f0f4ff] text-[#3370ff] dark:bg-blue-900/20 dark:text-blue-400"
            }`}
           >
             {notice.type === "error" ? (
               <AlertCircle className="w-[16px] h-[16px] mt-0.5 shrink-0" />
             ) : notice.type === "success" ? (
               <CheckCircle className="w-[16px] h-[16px] mt-0.5 shrink-0" />
             ) : (
               <Info className="w-[16px] h-[16px] mt-0.5 shrink-0" />
             )}
             <div className="leading-relaxed flex-1">{notice.text}</div>
           </div>
         )}

        {/* 模板设定 */}
        <div className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white">模板文档</div>
            {templateTitle ? (
              <div className="max-w-[62%] truncate text-[12px] text-[#8f959e]" title={templateTitle}>
                {templateTitle}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <div className="relative group flex-1">
                <input
                  className="w-full h-9 px-2.5 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[8px] text-[13px] focus:ring-2 focus:ring-[#3370ff]/30 focus:border-[#3370ff] transition-all outline-none placeholder-[#6b7480]"
                  placeholder="在此处粘贴模板文档链接"
                  type="url"
                  value={templateUrl}
                  onChange={(e) => {
                    setTemplateUrl(e.target.value);
                    if (templateTitle) {
                      setTemplateTitle("");
                      setVariables([]);
                      setBindings({});
                      setLinkConfigs({});
                      setAttachmentConfigs({});
                      setResults([]);
                      setCurrentStep("extract");
                    }
                  }}
                />
              </div>
              <button
                className="h-9 px-3 bg-[#3370ff] hover:bg-[#285bd4] text-white text-[13px] font-medium rounded-[8px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shrink-0"
                onClick={() => void handleExtractVariables()}
                disabled={isExtracting || !templateUrl.trim()}
              >
                {isExtracting ? (
                  <>
                    <span>提取中...</span>
                  </>
                ) : (
                    <span>提取变量</span>
                  )}
              </button>
            </div>
          </div>
          <div className="mt-1.5 pl-0.5 flex items-center gap-1.5 text-[12px] leading-none">
            <span className="text-[#8f959e]">不知道怎么创建模板？</span>
            <a
              href="https://www.feishu.cn/docx/CEgJdKzmZozxIexJfk3c5UwRnwd"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#3370ff] hover:text-[#245bdb] underline-offset-2 hover:underline transition-colors"
            >
              查看使用指南
            </a>
          </div>
        </div>

        {currentStep === "extract" ? (
          <div className="px-5 pb-6">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white">历史记录</div>
              <button
                type="button"
                onClick={() => void refreshSavedTemplates()}
                className="h-7 px-2.5 text-[12px] text-[#3370ff] hover:bg-[#f0f4ff] dark:hover:bg-blue-900/20 rounded-[6px] transition-colors"
              >
                刷新
              </button>
            </div>
            {savedTemplatesLoading ? (
              <div className="rounded-[10px] border border-[#ebedf0] dark:border-gray-700 bg-white dark:bg-[#1c1833] px-3 py-2.5 text-[12px] text-[#8f959e]">
                加载中...
              </div>
            ) : savedTemplates.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-[#cfd5dd] dark:border-gray-700 bg-[#f7f9fc] dark:bg-[#1c1833] px-4 py-5 text-center">
                <div className="text-[13px] font-medium text-[#5f6670] dark:text-gray-300">暂无历史模板</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {savedTemplates.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      void handleSelectSavedTemplate(item);
                    }}
                    disabled={isExtracting || selectedTemplateLoadingId === item.id}
                    className="text-left rounded-[10px] border border-[#ebedf0] dark:border-gray-700 bg-white dark:bg-[#1c1833] px-3 py-2.5 hover:border-[#bfd0ff] hover:bg-[#f7f9fc] dark:hover:bg-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[13px] font-medium text-[#1f2329] dark:text-gray-100 truncate">{item.templateTitle}</div>
                      {selectedTemplateLoadingId === item.id ? (
                        <Loader2 className="w-[14px] h-[14px] text-[#3370ff] icon-spin-smooth shrink-0" />
                      ) : null}
                    </div>
                    <div className="mt-1 text-[11px] text-[#8f959e]">最后更新：{formatDateTimeDisplay(item.updatedAt)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {templateTitle && currentStep !== "extract" && (
          <>
            <div className="h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />

            <div className="flex flex-col">

            <div className="order-1">

            {/* 字段映射 — 仅在有变量时展示 */}
            {variables.length > 0 ? (
              <div className="px-5 py-5">
                <div className="mb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white">
                      字段映射
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshTableContext()}
                      disabled={isLoadingContext}
                      className="h-7 shrink-0 inline-flex items-center gap-1 px-2 text-[12px] text-[#3370ff] hover:bg-[#f0f4ff] dark:hover:bg-blue-900/20 rounded-[6px] transition-colors disabled:opacity-50"
                    >
                      {isLoadingContext ? (
                        <Loader2 className="w-[13px] h-[13px] icon-spin-smooth" />
                      ) : (
                        <RefreshCw className="w-[13px] h-[13px]" />
                      )}
                      <span>刷新字段</span>
                    </button>
                  </div>
                  <div className="text-[12px] text-[#8f959e] mt-1">
                    将文档内的变量映射至当前数据表的对应列
                  </div>
                </div>

                <div className="space-y-1">
                  {variables.map((variable) => {
                    const isUnbound = !bindings[variable];
                    const boundFieldId = bindings[variable];
                    const boundField = boundFieldId ? fields.find((f) => f.id === boundFieldId) : undefined;
                    const isLinkField = boundField && LINK_FIELD_TYPES.has(boundField.type as FieldType);
                    const isAttachmentField = boundField?.type === ATTACHMENT_FIELD_TYPE;
                    const linkConfig = linkConfigs[variable];
                    const attachConfig = attachmentConfigs[variable];
                    const linkedTableId = isLinkField ? boundField.property?.tableId : undefined;
                    const linkedFields = linkedTableId ? (linkedTableFieldsCache[linkedTableId] ?? []) : [];
                    const isLinkedAttachmentField = Boolean(
                      isLinkField &&
                      linkConfig?.linkedFieldId &&
                      linkedFields.find((f) => f.id === linkConfig.linkedFieldId)?.type === ATTACHMENT_FIELD_TYPE,
                    );

                    const options: SelectOption[] = [
                      { value: UNBOUND_FIELD_VALUE, label: "原样保留 (不替换)" },
                      ...fields.flatMap((f) => {
                        const fieldVisual = getFieldTypeVisual(f.type);
                        if (!LINK_FIELD_TYPES.has(f.type as FieldType) || !f.property?.tableId) {
                          return [{ value: f.id, label: f.name, typeIcon: fieldVisual.icon, typeLabel: fieldVisual.label }];
                        }
                        const childFields = linkedTableFieldsCache[f.property.tableId] ?? [];
                        const childOptions = childFields.map((lf) => {
                          const childVisual = getFieldTypeVisual(lf.type);
                          return {
                            value: `${f.id}::${lf.id}`,
                            label: `${f.name} / ${lf.name}`,
                            typeIcon: childVisual.icon,
                            typeLabel: childVisual.label,
                          };
                        });
                        return [
                          {
                            value: `${f.id}::${LINK_SUMMARY_VALUE}`,
                            label: `${f.name} / 使用汇总文本`,
                            typeIcon: "link" as FieldIconKey,
                            typeLabel: "关联",
                            searchText: `${f.name} 汇总`,
                          },
                          ...childOptions,
                        ];
                      }),
                    ];

                    const selectedValue = isLinkField
                      ? `${boundFieldId}::${linkConfig?.linkedFieldId || LINK_SUMMARY_VALUE}`
                      : (boundFieldId || UNBOUND_FIELD_VALUE);

                    return (
                      <div key={variable} className="py-2 border-b border-[#ebedf0] dark:border-gray-700 last:border-b-0">
                        <div className="flex items-center gap-1.5">
                          <div
                            className="max-w-[36%] min-w-[78px] shrink text-[13px] text-[#1f2329] dark:text-gray-300 truncate"
                            title={variable}
                          >
                            {variable}
                          </div>
                          <ChevronsRight className="w-[14px] h-[14px] text-[#b8bec8] dark:text-gray-500 shrink-0" />
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <div className="flex-1 min-w-0">
                              <MappingSelect
                                value={selectedValue}
                                onChange={(val) => {
                                  if (val === UNBOUND_FIELD_VALUE) {
                                    handleBindingChange(variable, val);
                                    return;
                                  }

                                  if (!val.includes("::")) {
                                    handleBindingChange(variable, val);
                                    return;
                                  }

                                  const [fieldId, linkedFieldIdRaw] = val.split("::");
                                  const linkedFieldId = linkedFieldIdRaw === LINK_SUMMARY_VALUE ? "" : linkedFieldIdRaw;
                                  handleBindingChange(variable, fieldId);

                                  setLinkConfigs((prev) => ({
                                    ...prev,
                                    [variable]: { linkedFieldId },
                                  }));

                                  const parentField = fields.find((f) => f.id === fieldId);
                                  const linkedFields = parentField?.property?.tableId
                                    ? (linkedTableFieldsCache[parentField.property.tableId] ?? [])
                                    : [];
                                  const selectedLinkedField = linkedFields.find((f) => f.id === linkedFieldId);

                                  setAttachmentConfigs((prev) => {
                                    const next = { ...prev };
                                    if (selectedLinkedField?.type === ATTACHMENT_FIELD_TYPE) {
                                      if (!next[variable]) {
                                        next[variable] = { imageWidth: DEFAULT_IMAGE_WIDTH, widthMode: "preset" };
                                      }
                                    } else if (next[variable] && parentField?.type !== ATTACHMENT_FIELD_TYPE) {
                                      delete next[variable];
                                    }
                                    return next;
                                  });
                                }}
                                options={options}
                                isWarning={isUnbound}
                                compact
                                searchable
                              />
                            </div>
                          </div>
                        </div>

                        {(isAttachmentField || isLinkedAttachmentField) && attachConfig && (
                          <div className="mt-1.5 pt-1.5 border-t border-[#ebedf0] dark:border-gray-700 flex items-center gap-2.5">
                            <ImageIcon className="w-[14px] h-[14px] text-[#8f959e] shrink-0" />
                            <span className="text-[12px] text-[#8f959e] shrink-0">图片宽度</span>
                            <div className="w-[150px] shrink-0">
                              <MappingSelect
                                value={attachConfig.widthMode === "custom" ? ATTACH_WIDTH_CUSTOM_VALUE : String(attachConfig.imageWidth || DEFAULT_IMAGE_WIDTH)}
                                onChange={(val) => {
                                  if (val === ATTACH_WIDTH_CUSTOM_VALUE) {
                                    setAttachmentConfigs((prev) => ({
                                      ...prev,
                                      [variable]: {
                                        imageWidth: prev[variable]?.imageWidth || DEFAULT_IMAGE_WIDTH,
                                        widthMode: "custom",
                                      },
                                    }));
                                    return;
                                  }
                                  const preset = Math.max(0, Math.min(2000, Number(val) || DEFAULT_IMAGE_WIDTH));
                                  setAttachmentConfigs((prev) => ({
                                    ...prev,
                                    [variable]: { imageWidth: preset, widthMode: "preset" },
                                  }));
                                }}
                                options={[
                                  { value: String(DEFAULT_IMAGE_WIDTH), label: `${DEFAULT_IMAGE_WIDTH}px（默认）` },
                                  { value: "300", label: "300px" },
                                  { value: ATTACH_WIDTH_CUSTOM_VALUE, label: "自定义" },
                                ]}
                                compact
                              />
                            </div>
                            {attachConfig.widthMode === "custom" && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <input
                                  type="number"
                                  min={0}
                                  max={2000}
                                  className="w-[70px] px-2 py-1 text-[12px] bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] focus:ring-1 focus:ring-[#3370ff] focus:border-[#3370ff] outline-none"
                                  value={attachConfig.imageWidth || ""}
                                  placeholder="400"
                                  onChange={(e) => {
                                    const w = Math.max(0, Math.min(2000, Number(e.target.value) || 0));
                                    setAttachmentConfigs((prev) => ({
                                      ...prev,
                                      [variable]: {
                                        imageWidth: w,
                                        widthMode: "custom",
                                      },
                                    }));
                                  }}
                                />
                                <span className="text-[12px] text-[#8f959e]">px</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                 {hasUnboundVariables && (
                   <div className="mt-5 flex items-center gap-2 text-[13px] text-[#f5a623] bg-[#fff8ea] dark:bg-amber-900/10 px-4 py-3 rounded-[8px] border border-[#ffe4a8] dark:border-amber-900/30">
                     <Info className="w-[18px] h-[18px] text-[#f5a623] shrink-0" />
                     <span>未映射的变量将在生成文档时保持原样。</span>
                   </div>
                 )}
              </div>
            ) : (
              <div className="px-5 py-6">
                <div className="flex items-center gap-2 text-[13px] text-[#8f959e] bg-[#f5f6f7] dark:bg-gray-800/40 px-4 py-3 rounded-[8px]">
                  <Info className="w-[16px] h-[16px] text-[#8f959e] shrink-0" />
                  <span>该模板中未找到 {"{{变量}}"} 格式的占位符，生成时将直接复制文档。</span>
                </div>
              </div>
            )}

            </div>

            <div className="order-2 h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />

            <div className="order-3">

            <div className="px-5 py-6 space-y-6">
              <div>
                <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white">模板与生成设置</div>
                <div className="text-[12px] text-[#8f959e] mt-1">模板提取后，在这里设置生成文档的存放与协作规则。</div>
              </div>

              <div>
                <div className="mb-3 text-[14px] font-medium text-[#1f2329] dark:text-white">
                  生成的文档链接存放于
                </div>
                <StandardSelect
                  value={outputFieldId || AUTO_OUTPUT_FIELD_VALUE}
                  onChange={(val) =>
                    setOutputFieldId(val === AUTO_OUTPUT_FIELD_VALUE ? "" : val)
                  }
                  options={outputOptions}
                  searchable
                />
              </div>

              <div>
                <div className="mb-3 text-[14px] font-medium text-[#1f2329] dark:text-white">
                  文档命名
                </div>
                <StandardSelect
                  value={titleFieldId || AUTO_TITLE_FIELD_VALUE}
                  onChange={(val) =>
                    setTitleFieldId(val === AUTO_TITLE_FIELD_VALUE ? "" : val)
                  }
                  options={titleFieldOptions}
                  searchable
                />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between text-[14px] font-medium text-[#1f2329] dark:text-white">
                  <span>添加协作者 (可选)</span>
                </div>
                {collaborators.map((collab) => (
                  <div
                    key={collab.id}
                    className="flex items-center gap-2 mb-2"
                    ref={(el) => { collabContainerRefs.current[collab.id] = el; }}
                  >
                    <div className="flex-1 min-w-0 relative">
                      <div
                        className={`h-10 flex items-stretch bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[10px] ${
                          collab.user ? "overflow-visible" : "overflow-hidden"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          {collab.user ? (
                            <div className="h-full flex items-center gap-2 px-3 bg-[#f5f6f7] dark:bg-[#232033] rounded-l-[10px]">
                              {collab.user.avatar72 ? (
                                <img
                                  className="w-5 h-5 rounded-full object-cover bg-gray-100 shrink-0"
                                  src={collab.user.avatar72}
                                  alt=""
                                />
                              ) : (
                                <span
                                  className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0"
                                  style={{ backgroundColor: getAvatarColor(collab.user) }}
                                >
                                  {buildAvatarText(collab.user)}
                                </span>
                              )}
                              <span className="text-[13px] text-[#1f2329] dark:text-gray-200 truncate flex-1">
                                {formatOwnerLabel(collab.user)}
                              </span>
                              <button
                                type="button"
                                className="w-5 h-5 flex items-center justify-center text-[#8f959e] hover:text-[#1f2329] rounded transition-colors shrink-0"
                                onClick={() => updateCollaborator(collab.id, { user: null, keyword: "", candidates: [], searchOpen: false, roleOpen: false })}
                              >
                                <X className="w-[12px] h-[12px]" />
                              </button>
                            </div>
                          ) : (
                            <div className="relative h-full rounded-[10px]">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 w-[16px] h-[16px] pointer-events-none">
                                <Search
                                  className={`absolute inset-0 w-[16px] h-[16px] text-[#8f959e] transition-opacity ${
                                    collab.searchLoading ? "opacity-0" : "opacity-100"
                                  }`}
                                />
                                <Loader2
                                  className={`absolute inset-0 w-[16px] h-[16px] text-[#3370ff] icon-spin-smooth transition-opacity ${
                                    collab.searchLoading ? "opacity-100" : "opacity-0"
                                  }`}
                                />
                              </span>
                              <input
                                className="w-full h-full pl-9 pr-3 border-0 rounded-[10px] bg-white dark:bg-[#1c1833] text-[14px] focus:ring-0 focus:outline-none outline-none placeholder-[#8f959e]"
                                placeholder="搜索姓名"
                                value={collab.keyword}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateCollaborator(collab.id, { keyword: val, user: null, roleOpen: false });
                                  if (collabSearchTimers.current[collab.id]) {
                                    window.clearTimeout(collabSearchTimers.current[collab.id]);
                                  }
                                  if (val.trim()) {
                                    collabSearchTimers.current[collab.id] = window.setTimeout(() => {
                                      void searchCollaboratorUsers(collab.id, val);
                                    }, 200);
                                  } else {
                                    void searchCollaboratorUsers(collab.id, "");
                                  }
                                }}
                                onFocus={() => {
                                  if (!collab.user) {
                                    void searchCollaboratorUsers(collab.id, collab.keyword);
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>

                        {collab.user ? (
                          <div className="relative shrink-0 flex items-center">
                            <button
                              type="button"
                              onClick={() => updateCollaborator(collab.id, { roleOpen: !collab.roleOpen })}
                              className={`h-full flex items-center gap-1 px-3 text-[13px] bg-transparent rounded-r-[10px] transition-colors ${
                                collab.roleOpen ? "text-[#3370ff]" : "text-[#1f2329] dark:text-gray-300"
                              }`}
                            >
                              <span>{COLLABORATOR_ROLES.find((r) => r.id === collab.role)?.label}</span>
                              <ChevronDown className="w-[14px] h-[14px] text-[#8f959e]" />
                            </button>
                            {collab.roleOpen && (
                              <div className="absolute z-20 right-0 top-[calc(100%+6px)] w-[100px] py-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
                                {COLLABORATOR_ROLES.map((role) => (
                                  <button
                                    key={role.id}
                                    type="button"
                                    className="w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between hover:bg-[#f5f6f7] dark:hover:bg-gray-800 transition-colors text-[#1f2329] dark:text-gray-200"
                                    onClick={() => updateCollaborator(collab.id, { role: role.id, roleOpen: false })}
                                  >
                                    <span>{role.label}</span>
                                    {role.id === collab.role && (
                                      <Check className="w-[14px] h-[14px] text-[#3370ff]" />
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>

                      {collab.searchOpen && (
                        <div className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] max-h-[200px] overflow-y-auto py-1">
                          {collab.searchLoading ? (
                            <div className="flex items-center justify-center gap-2 text-[12px] text-[#8f959e] px-3 py-2.5">
                              <Loader2 className="w-[12px] h-[12px] icon-spin-smooth" />
                              <span>搜索中...</span>
                            </div>
                          ) : collab.candidates.length === 0 ? (
                            <div className="text-[12px] text-[#8f959e] px-3 py-2.5 text-center">
                              没有匹配结果，换个关键词试试吧
                            </div>
                          ) : (
                            collab.candidates.map((candidate) => (
                              <button
                                type="button"
                                key={candidate.openId}
                                className="w-full text-left px-3 py-2 hover:bg-[#f5f6f7] dark:hover:bg-gray-800 flex items-center gap-2 transition-colors"
                                onClick={() => {
                                  updateCollaborator(collab.id, {
                                    user: candidate,
                                    keyword: formatOwnerLabel(candidate),
                                    role: "view",
                                    searchOpen: false,
                                    candidates: [],
                                    roleOpen: false,
                                  });
                                }}
                              >
                                {candidate.avatar72 ? (
                                  <img className="w-6 h-6 rounded-full object-cover bg-gray-100" src={candidate.avatar72} alt="" />
                                ) : (
                                  <span
                                    className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                                    style={{ backgroundColor: getAvatarColor(candidate) }}
                                  >
                                    {buildAvatarText(candidate)}
                                  </span>
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] text-[#1f2329] dark:text-white font-medium truncate">
                                    {formatOwnerLabel(candidate)}
                                  </div>
                                  <div className="text-[11px] text-[#8f959e] truncate">
                                    {candidate.departments?.join(" / ") || "暂无部门"}
                                  </div>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className="w-8 h-8 flex items-center justify-center text-[#8f959e] hover:text-[#f54a45] hover:bg-red-50 dark:hover:bg-red-900/20 rounded-[6px] transition-colors shrink-0"
                      onClick={() => removeCollaborator(collab.id)}
                    >
                      <Trash2 className="w-[14px] h-[14px]" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addCollaborator}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-[#3370ff] hover:bg-[#f0f4ff] dark:hover:bg-blue-900/20 rounded-[6px] transition-colors"
                >
                  <Plus className="w-[14px] h-[14px]" />
                  <span>添加协作者</span>
                </button>
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowAdvancedSettings((prev) => !prev)}
                  className="w-full h-9 px-3 flex items-center justify-between rounded-[8px] border border-[#dee0e3] dark:border-gray-700 bg-white dark:bg-[#1c1833] text-[13px] text-[#1f2329] dark:text-gray-200 hover:border-[#bfd0ff] transition-colors"
                >
                  <span className="font-medium">高级配置</span>
                  <ChevronDown className={`w-[14px] h-[14px] text-[#8f959e] transition-transform ${showAdvancedSettings ? "rotate-180" : ""}`} />
                </button>

                {showAdvancedSettings ? (
                  <div className="mt-2 rounded-[8px] border border-[#ebedf0] dark:border-gray-700 bg-[#fafbfc] dark:bg-[#181525] p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[13px] text-[#1f2329] dark:text-gray-200">启用文档所有权转移</div>
                      <label className="inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={advancedSettings.ownerTransferEnabled}
                          onChange={(e) => setAdvancedSettings((prev) => ({ ...prev, ownerTransferEnabled: e.target.checked }))}
                        />
                        <span className={`w-9 h-5 rounded-full transition-colors ${advancedSettings.ownerTransferEnabled ? "bg-[#3370ff]" : "bg-[#cfd5dd]"}`}>
                          <span className={`block w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${advancedSettings.ownerTransferEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                        </span>
                      </label>
                    </div>

                    {advancedSettings.ownerTransferEnabled ? (
                      <>
                        <div className="text-[12px] text-[#8f959e]">默认转移到当前登录人，可自定义转移细项。</div>

                        <div>
                          <div className="mb-2 text-[12px] text-[#5f6670] dark:text-gray-300">原所有者权限</div>
                          <StandardSelect
                            value={advancedSettings.ownerTransferOldOwnerPerm}
                            onChange={(val) => {
                              if (val === "view" || val === "edit" || val === "full_access") {
                                setAdvancedSettings((prev) => ({ ...prev, ownerTransferOldOwnerPerm: val }));
                              }
                            }}
                            options={[
                              { value: "view", label: "可阅读" },
                              { value: "edit", label: "可编辑" },
                              { value: "full_access", label: "可管理" },
                            ]}
                          />
                        </div>

                        <label className="flex items-center gap-2 text-[12px] text-[#5f6670] dark:text-gray-300">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 rounded border-[#cfd5dd] text-[#3370ff] focus:ring-[#3370ff]/30"
                            checked={advancedSettings.ownerTransferNeedNotification}
                            onChange={(e) => setAdvancedSettings((prev) => ({ ...prev, ownerTransferNeedNotification: e.target.checked }))}
                          />
                          <span>发送转移通知</span>
                        </label>

                        <label className="flex items-center gap-2 text-[12px] text-[#5f6670] dark:text-gray-300">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 rounded border-[#cfd5dd] text-[#3370ff] focus:ring-[#3370ff]/30"
                            checked={advancedSettings.ownerTransferRemoveOldOwner}
                            onChange={(e) => setAdvancedSettings((prev) => ({ ...prev, ownerTransferRemoveOldOwner: e.target.checked }))}
                          />
                          <span>移除原所有者</span>
                        </label>

                        <label className="flex items-center gap-2 text-[12px] text-[#5f6670] dark:text-gray-300">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 rounded border-[#cfd5dd] text-[#3370ff] focus:ring-[#3370ff]/30"
                            checked={advancedSettings.ownerTransferStayPut}
                            onChange={(e) => setAdvancedSettings((prev) => ({ ...prev, ownerTransferStayPut: e.target.checked }))}
                          />
                          <span>保持文档位置不变</span>
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {currentStep === "configure" ? (
                <div className="mt-5 pt-5 border-t border-[#dee0e3] dark:border-gray-800">
                  <button
                    type="button"
                    onClick={() => handleContinueToGenerate()}
                    className="w-full h-10 rounded-[8px] bg-[#3370ff] text-white text-[14px] font-medium hover:bg-[#285bd4] transition-colors"
                  >
                    下一步：进入生成
                  </button>
                </div>
              ) : null}

              {currentStep === "generate" ? (
                <div className="mt-5 pt-5 border-t border-[#dee0e3] dark:border-gray-800 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[14px] font-medium text-[#1f2329] dark:text-white">第 4 步：开始生成</div>
                    <button
                      type="button"
                      onClick={() => handleBackToConfig()}
                      className="h-8 px-3 text-[12px] text-[#3370ff] hover:bg-[#f0f4ff] rounded-[6px] transition-colors"
                    >
                      返回配置
                    </button>
                  </div>

                  {generateProgress.visible ? (
                    <div className="rounded-[8px] border border-[#e6e8eb] dark:border-gray-700 bg-white dark:bg-[#1c1833] px-3 py-2.5">
                      <div className="flex items-center justify-between text-[12px] mb-1.5">
                        <span className="text-[#5f6670] dark:text-gray-300">{generateProgress.phase}</span>
                        <span className="text-[#8f959e]">
                          {Math.min(generateProgress.completed, generateProgress.total)} / {generateProgress.total}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[#eef1f5] dark:bg-gray-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#3370ff] transition-all duration-300"
                          style={{
                            width: `${generateProgress.total > 0 ? Math.min(100, Math.round((generateProgress.completed / generateProgress.total) * 100)) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      className="py-2.5 bg-white dark:bg-gray-800 border border-[#dee0e3] dark:border-gray-700 text-[#1f2329] dark:text-gray-300 text-[14px] font-medium rounded-[8px] hover:bg-[#f5f6f7] dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => void handleGenerate("selected")}
                      disabled={isGenerating || !selectedRecordIds.length || !templateTitle}
                    >
                      生成选中项
                    </button>
                    <button
                      className="py-2.5 bg-[#3370ff] text-white text-[14px] font-medium rounded-[8px] hover:bg-[#285bd4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 shadow-sm shadow-[#3370ff]/20"
                      onClick={() => void handleGenerate("all")}
                      disabled={isGenerating || !templateTitle}
                    >
                      {isGenerating ? (
                        <Loader2 className="w-[18px] h-[18px] icon-spin-smooth" />
                      ) : (
                        <Rocket className="w-[18px] h-[18px]" />
                      )}
                      <span>全部生成</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            </div>

            </div>

            {/* 执行结果区 */}
            {currentStep === "generate" && results.length > 0 && (
              <>
                <div className="h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />
                <div className="px-5 py-6 space-y-3">
                  <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white mb-4">
                    执行日志
                  </div>
                  {results.map((result, idx) => (
                    <div
                      key={`${result.recordId}-${idx}`}
                      className="text-[13px] bg-[#f5f6f7] dark:bg-gray-800/30 border border-[#dee0e3] dark:border-gray-800 rounded-[8px] p-3"
                    >
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="text-[#8f959e] font-mono truncate max-w-[60%]">
                          ID: {result.recordId}
                        </span>
                         <span
                           className={`flex items-center gap-1 ${result.status === "success" ? "text-[#34c759]" : "text-[#f54a45]"}`}
                         >
                           {result.status === "success" ? (
                             <CheckCircle className="w-[16px] h-[16px]" />
                           ) : (
                             <AlertCircle className="w-[16px] h-[16px]" />
                           )}
                           <span>
                             {result.status === "success" ? "成功" : "失败"}
                           </span>
                         </span>
                      </div>
                      <div className="flex justify-between items-center">
                        {result.docUrl ? (
                           <a
                             href={result.docUrl}
                             target="_blank"
                             rel="noreferrer"
                             className="text-[#3370ff] hover:underline flex items-center gap-1 font-medium"
                           >
                             查看文档{" "}
                             <ExternalLink className="w-[16px] h-[16px]" />
                           </a>
                        ) : (
                          <span>—</span>
                        )}
                        <span
                          className="text-[#8f959e] truncate max-w-[60%] text-right"
                          title={
                            result.error ||
                            formatWarnings(result.warnings) ||
                            (result.replacedBlocks
                              ? `替换 ${result.replacedBlocks} 处`
                              : "—")
                          }
                        >
                          {result.error ||
                            formatWarnings(result.warnings) ||
                            (result.replacedBlocks
                              ? `替换 ${result.replacedBlocks} 处`
                              : "—")}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {showUnboundModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-[#1c1833] rounded-[12px] shadow-[0_8px_30px_rgba(0,0,0,0.15)] w-[calc(100%-40px)] max-w-[360px] p-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertCircle className="w-[20px] h-[20px] text-[#f5a623] shrink-0 mt-0.5" />
              <div>
                <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white mb-1">
                  存在未映射的变量
                </div>
                <div className="text-[13px] text-[#8f959e] leading-relaxed">
                  以下变量未绑定字段，生成后将保留原始占位符：
                </div>
              </div>
            </div>
            <div className="mb-5 bg-[#fff8ea] dark:bg-amber-900/10 rounded-[8px] px-4 py-3 border border-[#ffe4a8] dark:border-amber-900/30">
              <div className="flex flex-wrap gap-1.5">
                {unboundVariableNames.map((name) => (
                  <span
                    key={name}
                    className="inline-block px-2 py-0.5 text-[12px] text-[#f5a623] bg-white dark:bg-[#1c1833] rounded border border-[#ffe4a8] dark:border-amber-900/30 font-mono"
                  >
                    {`{{${name}}}`}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 py-2 text-[14px] font-medium text-[#1f2329] dark:text-gray-300 bg-[#f5f6f7] dark:bg-gray-800 hover:bg-[#ebeced] dark:hover:bg-gray-700 rounded-[8px] transition-colors"
                onClick={() => {
                  setShowUnboundModal(false);
                  setPendingGenerateMode(null);
                }}
              >
                返回修改
              </button>
              <button
                type="button"
                className="flex-1 py-2 text-[14px] font-medium text-white bg-[#3370ff] hover:bg-[#285bd4] rounded-[8px] transition-colors"
                onClick={() => {
                  setShowUnboundModal(false);
                  if (pendingGenerateMode) {
                    void executeGenerate(pendingGenerateMode);
                    setPendingGenerateMode(null);
                  }
                }}
              >
                继续生成
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
