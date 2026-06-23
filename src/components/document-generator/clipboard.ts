export type ClipboardCopyResult = 'copied' | 'selected';

interface CopyTextOptions {
  target?: HTMLElement | null;
}

export async function copyTextToClipboard(text: string, options: CopyTextOptions = {}): Promise<ClipboardCopyResult> {
  const target = options.target ?? null;
  const embedded = isEmbeddedPage();
  const strategies = embedded
    ? [
        ...(target ? [() => copyWithVisibleSelectionTarget(text, target, embedded)] : []),
        () => copyWithNavigatorClipboard(text),
      ]
    : [
        () => copyWithNavigatorClipboard(text),
        () => copyWithSelectionFallback(text),
        ...(target ? [() => copyWithVisibleSelectionTarget(text, target, embedded)] : []),
      ];

  let lastError: unknown = null;
  for (const strategy of strategies) {
    try {
      return await strategy();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('copy_failed');
}

function isEmbeddedPage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function copyWithNavigatorClipboard(text: string): Promise<ClipboardCopyResult> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('clipboard_api_unavailable');
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}

function copyWithSelectionFallback(text: string): Promise<ClipboardCopyResult> {
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('document_unavailable');
  }

  const activeElement = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const selection = document.getSelection();
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_item, index) => selection.getRangeAt(index).cloneRange())
    : [];

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '0';
  textarea.style.top = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('copy_command_failed');
  } finally {
    document.body.removeChild(textarea);
    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) selection.addRange(range);
    }
    activeElement?.focus({ preventScroll: true });
  }

  return Promise.resolve('copied');
}

function copyWithVisibleSelectionTarget(
  text: string,
  target: HTMLElement,
  embedded: boolean,
): Promise<ClipboardCopyResult> {
  if (typeof document === 'undefined') {
    throw new Error('document_unavailable');
  }

  selectVisibleTarget(target, text);

  const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  if (!copied && !targetHasText(target, text)) {
    throw new Error('copy_command_failed');
  }

  return Promise.resolve(embedded ? 'selected' : copied ? 'copied' : 'selected');
}

function selectVisibleTarget(target: HTMLElement, text: string): void {
  if (isTextInput(target)) {
    target.focus({ preventScroll: true });
    target.select();
    target.setSelectionRange(0, target.value.length);
    return;
  }

  const selection = document.getSelection();
  if (!selection) throw new Error('selection_unavailable');
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);

  if (!targetHasText(target, text)) {
    throw new Error('target_text_mismatch');
  }
}

function isTextInput(target: HTMLElement): target is HTMLInputElement | HTMLTextAreaElement {
  return (
    (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement)
  );
}

function targetHasText(target: HTMLElement, text: string): boolean {
  const value = isTextInput(target) ? target.value : target.textContent || '';
  return value.trim() === text;
}
