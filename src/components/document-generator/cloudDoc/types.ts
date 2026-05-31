import type { ITable } from '@lark-base-open/js-sdk';
import type { TableField } from '../types';

export interface TemplateVariablesResponse {
  ok: true;
  documentId: string;
  templateTitle: string;
  variables: string[];
}

export interface GenerateResult {
  recordId: string;
  status: 'success' | 'failed';
  docUrl?: string;
  documentTitle?: string;
  warnings?: string[];
  error?: string;
}

export interface GenerateResponse {
  ok: true;
  results: GenerateResult[];
}

export interface ProgressState {
  total: number;
  done: number;
  phase: string;
}

export type NoticeState = { type: 'info' | 'success' | 'error'; text: string } | null;

export type CloudRange = 'selected' | 'all';

export interface CloudDocRuntimeInput {
  fields: TableField[];
  activeTableId?: string | null;
  selectedRecordIds: string[];
  allRecordIds: string[];
  selectedCount: number;
  totalRecordCount: number;
  bitableAvailable: boolean;
  refreshBitable?: () => Promise<void>;
  demo?: boolean;
}

export interface CloudDocState {
  textFields: TableField[];
  outputFields: TableField[];
  templateUrl: string;
  templateTitle: string;
  variables: string[];
  mapping: Record<string, string>;
  outputFieldId: string;
  range: CloudRange;
  notice: NoticeState;
  extracting: boolean;
  generating: boolean;
  progress: ProgressState;
  results: GenerateResult[];
  targetCount: number;
  unmappedCount: number;
  canExtract: boolean;
  canGenerate: boolean;
}

export interface CloudDocActions {
  setTemplateUrl: (value: string) => void;
  setRange: (value: CloudRange) => void;
  setOutputFieldId: (value: string) => void;
  applyMapping: (next: Record<string, string>) => void;
  saveAutoConfig: (nextMapping: Record<string, string>, nextOutputFieldId: string) => void;
  extractVariables: () => Promise<void>;
  generate: () => Promise<void>;
}

export interface ResolvedCloudTable {
  table: ITable;
  targetIds: string[];
}
