export type FieldKind =
  | 'text'
  | 'number'
  | 'date'
  | 'phone'
  | 'person'
  | 'select'
  | 'attachment';

export interface TableField {
  id: string;
  name: string;
  type: FieldKind;
  icon: string;
  rawType?: number;
}

export interface TemplateVariable {
  name: string;
  kind: 'text' | 'image';
  suggested?: string;
}

export interface TemplateThumbnailLine {
  text: string;
  role: 'title' | 'body';
}

export interface TemplateThumbnail {
  kind: 'docx-outline';
  pageRatio: number;
  lines: TemplateThumbnailLine[];
  variableNames: string[];
  hasImagePlaceholders: boolean;
}

export interface Template {
  id: string;
  name: string;
  varCount: number;
  updatedAt: string;
  category: string;
  visibility?: 'private' | 'shared';
  kind: 'doc' | 'sheet';
  variables?: TemplateVariable[];
  thumbnail?: TemplateThumbnail;
  hasLogo?: boolean;
}

export interface TableRow {
  客户名称: string;
  合同金额: string;
  签订日期: string;
  联系人: string;
  状态: '待生成' | '已生成' | '失败';
}

export type AccentKey = 'blue' | 'teal' | 'graphite' | 'amber';

export interface Accent {
  primary: string;
  soft: string;
}

export type GeneratorKind = 'word' | 'feishu';

export type Phase = 'idle' | 'running' | 'paused' | 'done' | 'terminated';
export type RecordStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface RecordItem {
  id: string;
  displayName: string;
  status: RecordStatus;
  error: string | null;
  downloadUrl?: string;
  fileName?: string;
  warning?: string | null;
}

export interface Counts {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  processing: number;
}

export interface RecordSpec {
  id: string;
  displayName: string;
}

export interface GenerateOptions {
  template: Template | null;
  sourceMode?: 'bitable' | 'standalone';
  mapping: Record<string, string>;
  customText: Record<string, string>;
  fileNameTpl: string;
  writeBackField: string;
  expires: string;
  onMissing: string;
}

export type PreviewOutcome =
  | { ok: true; fileBase64: string; contentType: string }
  | { ok: false; error: string };

export interface GenerateRunner {
  items: RecordItem[];
  phase: Phase;
  counts: Counts;
  startedAt: number;
  start: (records: RecordSpec[], options?: GenerateOptions) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  retry: () => void;
  reset: () => void;
  // 用"变量名作值"渲染整模板并返回保真 PDF（Gotenberg），让用户在批量生成前先确认样式统一。
  preview: (template: Template) => Promise<PreviewOutcome>;
}

export interface PrimaryState {
  template: Template | null;
  sourceMode?: 'bitable' | 'standalone';
  mapping: Record<string, string>;
  customText: Record<string, string>;
  fileNameTpl: string;
  selectedCount: number;
  expires: string;
  onMissing: string;
  writeBack: boolean;
  writeBackField: string;
}
