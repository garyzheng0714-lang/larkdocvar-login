export async function copyTextToClipboard(text: string): Promise<void> {
  const strategies = isEmbeddedPage()
    ? [copyWithSelectionFallback, copyWithNavigatorClipboard]
    : [copyWithNavigatorClipboard, copyWithSelectionFallback];

  let lastError: unknown = null;
  for (const strategy of strategies) {
    try {
      await strategy(text);
      return;
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

async function copyWithNavigatorClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('clipboard_api_unavailable');
  }
  await navigator.clipboard.writeText(text);
}

function copyWithSelectionFallback(text: string): Promise<void> {
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

  return Promise.resolve();
}
