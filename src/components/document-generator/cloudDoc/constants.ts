import type { Accent } from '../types';

export const BATCH_SIZE = 10;
export const AUTO_OUTPUT_FIELD = '__auto_output_field__';

export const CLOUD_DOC_ACCENTS: Record<'blue' | 'teal' | 'graphite' | 'amber', Accent> = {
  blue: { primary: '#2b5fed', soft: '#ecf0fe' },
  teal: { primary: '#0d8a7c', soft: '#e3f4f1' },
  graphite: { primary: '#374254', soft: '#eceef2' },
  amber: { primary: '#b9621a', soft: '#fbeedf' },
};
