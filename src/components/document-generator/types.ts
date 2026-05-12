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
}

export interface TemplateVariable {
  name: string;
  kind: 'text' | 'image';
  suggested?: string;
}

export interface Template {
  id: string;
  name: string;
  varCount: number;
  updatedAt: string;
  category: string;
  kind: 'doc' | 'sheet';
  variables?: TemplateVariable[];
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

export type Phase = 'running' | 'paused' | 'done' | 'terminated';
export type RecordStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface RecordItem extends TableRow {
  status: RecordStatus;
  error: string | null;
}

export interface PrimaryState {
  template: Template | null;
  mapping: Record<string, string>;
  customText: Record<string, string>;
  fileNameTpl: string;
  selectedCount: number;
  expires: string;
  onMissing: string;
  writeBack: boolean;
  writeBackField: string;
}
