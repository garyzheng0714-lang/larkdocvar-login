import assert from 'node:assert/strict';
import test from 'node:test';
import { copyTextToClipboard } from './clipboard';

const originalWindow = Reflect.get(globalThis, 'window');
const originalDocument = Reflect.get(globalThis, 'document');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreGlobals(): void {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Reflect.set(globalThis, 'window', originalWindow);
  }

  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document');
  } else {
    Reflect.set(globalThis, 'document', originalDocument);
  }

  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
}

function installClipboardDom(options: {
  embedded: boolean;
  clipboardWriteText?: (text: string) => Promise<void>;
  execCommand?: (command: string, copiedText: string) => boolean;
}): { getNavigatorCalls: () => number; getExecCalls: () => number } {
  let appendedTextarea: { value: string } | null = null;
  let navigatorCalls = 0;
  let execCalls = 0;

  const topWindow: Record<string, unknown> = {};
  const fakeWindow: Record<string, unknown> = {
    self: options.embedded ? {} : topWindow,
    top: topWindow,
  };
  Reflect.set(globalThis, 'window', fakeWindow);
  if (!options.embedded) {
    fakeWindow.self = fakeWindow.top;
  }

  Reflect.set(globalThis, 'document', {
    activeElement: null,
    body: {
      appendChild(element: { value: string }) {
        appendedTextarea = element;
      },
      removeChild(element: { value: string }) {
        if (appendedTextarea === element) appendedTextarea = null;
      },
    },
    createElement() {
      return {
        value: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
      };
    },
    execCommand(command: string) {
      execCalls += 1;
      return options.execCommand?.(command, appendedTextarea?.value || '') ?? true;
    },
    getSelection() {
      return null;
    },
  });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText(text: string) {
          navigatorCalls += 1;
          return options.clipboardWriteText?.(text) ?? Promise.resolve();
        },
      },
    },
  });

  return {
    getNavigatorCalls: () => navigatorCalls,
    getExecCalls: () => execCalls,
  };
}

test.afterEach(() => {
  restoreGlobals();
});

test('飞书 iframe 中即使 Clipboard API 存在，也优先用同步选择复制兜底', async () => {
  const calls = installClipboardDom({
    embedded: true,
    clipboardWriteText: async () => {
      throw new Error('permission denied');
    },
    execCommand: (command, copiedText) => command === 'copy' && copiedText === 'tpl_20260529_3b4bb678',
  });

  await copyTextToClipboard('tpl_20260529_3b4bb678');

  assert.equal(calls.getExecCalls(), 1);
  assert.equal(calls.getNavigatorCalls(), 0);
});

test('普通浏览器里 Clipboard API 拒绝后仍回退到选择复制', async () => {
  const calls = installClipboardDom({
    embedded: false,
    clipboardWriteText: async () => {
      throw new Error('permission denied');
    },
    execCommand: (command, copiedText) => command === 'copy' && copiedText === 'tpl_001',
  });

  await copyTextToClipboard('tpl_001');

  assert.equal(calls.getNavigatorCalls(), 1);
  assert.equal(calls.getExecCalls(), 1);
});
