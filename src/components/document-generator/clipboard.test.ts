import assert from 'node:assert/strict';
import test from 'node:test';
import { copyTextToClipboard } from './clipboard';

const originalWindow = Reflect.get(globalThis, 'window');
const originalDocument = Reflect.get(globalThis, 'document');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalHTMLInputElement = Reflect.get(globalThis, 'HTMLInputElement');
const originalHTMLTextAreaElement = Reflect.get(globalThis, 'HTMLTextAreaElement');

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

  if (originalHTMLInputElement === undefined) {
    Reflect.deleteProperty(globalThis, 'HTMLInputElement');
  } else {
    Reflect.set(globalThis, 'HTMLInputElement', originalHTMLInputElement);
  }

  if (originalHTMLTextAreaElement === undefined) {
    Reflect.deleteProperty(globalThis, 'HTMLTextAreaElement');
  } else {
    Reflect.set(globalThis, 'HTMLTextAreaElement', originalHTMLTextAreaElement);
  }
}

function installClipboardDom(options: {
  embedded: boolean;
  clipboardWriteText?: (text: string) => Promise<void>;
  execCommand?: (command: string, copiedText: string) => boolean;
}): { createInputTarget: (value: string) => HTMLInputElement; getNavigatorCalls: () => number; getExecCalls: () => number } {
  let appendedTextarea: { value: string } | null = null;
  let selectedText = '';
  let navigatorCalls = 0;
  let execCalls = 0;

  class FakeInput {
    value = '';
    focus() {}
    select() {
      selectedText = this.value;
    }
    setSelectionRange() {
      selectedText = this.value;
    }
  }

  Reflect.set(globalThis, 'HTMLInputElement', FakeInput);
  Reflect.set(globalThis, 'HTMLTextAreaElement', FakeInput);

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
      const input = new FakeInput() as FakeInput & { style: Record<string, string>; setAttribute: () => void };
      input.style = {};
      input.setAttribute = () => undefined;
      return input;
    },
    execCommand(command: string) {
      execCalls += 1;
      return options.execCommand?.(command, appendedTextarea?.value || selectedText) ?? true;
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
    createInputTarget: (value: string) => {
      const input = new FakeInput();
      input.value = value;
      return input as unknown as HTMLInputElement;
    },
    getNavigatorCalls: () => navigatorCalls,
    getExecCalls: () => execCalls,
  };
}

test.afterEach(() => {
  restoreGlobals();
});

test('飞书 iframe 中优先选中可见 ID，不让不可验证的 Clipboard API 成功短路兜底', async () => {
  const calls = installClipboardDom({
    embedded: true,
    clipboardWriteText: async () => {
      throw new Error('visible selection should run before clipboard api');
    },
    execCommand: (command, copiedText) => command === 'copy' && copiedText === 'tpl_20260529_3b4bb678',
  });

  const result = await copyTextToClipboard('tpl_20260529_3b4bb678', {
    target: calls.createInputTarget('tpl_20260529_3b4bb678'),
  });

  assert.equal(result, 'selected');
  assert.equal(calls.getExecCalls(), 1);
  assert.equal(calls.getNavigatorCalls(), 0);
});

test('飞书 iframe 中没有可见目标时才回退到 Clipboard API', async () => {
  const calls = installClipboardDom({
    embedded: true,
    clipboardWriteText: async (text) => {
      assert.equal(text, 'tpl_20260529_3b4bb678');
    },
  });

  const result = await copyTextToClipboard('tpl_20260529_3b4bb678');

  assert.equal(result, 'copied');
  assert.equal(calls.getExecCalls(), 0);
  assert.equal(calls.getNavigatorCalls(), 1);
});

test('普通浏览器里 Clipboard API 拒绝后仍回退到选择复制', async () => {
  const calls = installClipboardDom({
    embedded: false,
    clipboardWriteText: async () => {
      throw new Error('permission denied');
    },
    execCommand: (command, copiedText) => command === 'copy' && copiedText === 'tpl_001',
  });

  const result = await copyTextToClipboard('tpl_001');

  assert.equal(result, 'copied');
  assert.equal(calls.getNavigatorCalls(), 1);
  assert.equal(calls.getExecCalls(), 1);
});
