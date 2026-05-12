export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function sanitizeFileName(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  return cleaned || fallback;
}

export function ensureDocxExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith('.docx') ? fileName : `${fileName}.docx`;
}

export function buildContentDisposition(fileName: string): string {
  return `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
