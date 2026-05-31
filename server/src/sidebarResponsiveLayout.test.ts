import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 读取所有拆分的 CSS 文件
const baseCss = readFileSync(
  new URL('../../src/components/document-generator/_base.css', import.meta.url),
  'utf8',
);
const layoutCss = readFileSync(
  new URL('../../src/components/document-generator/_layout.css', import.meta.url),
  'utf8',
);
const componentsCss = readFileSync(
  new URL('../../src/components/document-generator/_components.css', import.meta.url),
  'utf8',
);
const responsiveCss = readFileSync(
  new URL('../../src/components/document-generator/_responsive.css', import.meta.url),
  'utf8',
);
const css = baseCss + layoutCss + componentsCss + responsiveCss;

const dropdownSource = readFileSync(
  new URL('../../src/components/document-generator/Dropdown.tsx', import.meta.url),
  'utf8',
);

const primaryScreenSource = readFileSync(
  new URL('../../src/components/document-generator/PrimaryScreen.tsx', import.meta.url),
  'utf8',
);

const generatorHeaderSource = readFileSync(
  new URL('../../src/components/document-generator/GeneratorHeader.tsx', import.meta.url),
  'utf8',
);

test('真实飞书侧边栏宽度跟随 iframe 容器，不写死面板宽度', () => {
  assert.match(css, /\.sidebar\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.sidebar\s*\{[\s\S]*?container-type:\s*inline-size;/);
  assert.doesNotMatch(css, /\.sidebar\s*\{[\s\S]*?(?:min-)?width:\s*380px/);
});

test('窄侧边栏下关键操作区使用容器查询收缩，避免右侧按钮被裁切', () => {
  assert.match(css, /@container\s*\(max-width:\s*430px\)/);
  assert.match(css, /\.mapping-card\s*\{/);
  assert.match(css, /\.mapping-mode-switch\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/);
  assert.match(css, /\.btn-primary\s*\{[\s\S]*?flex-shrink:\s*0;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(css, /\.ftr-info\s*\{[\s\S]*?min-width:\s*0;/);
});

test('下拉菜单必须按 iframe 可视宽度钳制，不能按固定定位溢出右边界', () => {
  assert.match(dropdownSource, /window\.innerWidth/);
  assert.match(dropdownSource, /EDGE_GAP/);
  assert.match(dropdownSource, /Math\.min\(Math\.max\(rawLeft,\s*EDGE_GAP\),\s*maxLeft\)/);
});

test('多维表格侧边栏标题和字段映射固定值入口保持显式可见', () => {
  assert.match(generatorHeaderSource, /alt="FBIF"/);
  assert.match(generatorHeaderSource, /批量生成文档工具/);
  assert.match(generatorHeaderSource, /<div className="hdr-mode-row">/);
  assert.match(css, /\.app-brand-header\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.hdr-mode-row\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(primaryScreenSource, /mapping-mode-switch/);
  assert.match(primaryScreenSource, /mapping-field-search/);
  assert.match(primaryScreenSource, /mapping-fixed-input/);
  assert.match(primaryScreenSource, /固定值/);
  assert.match(primaryScreenSource, /onCustomText\(e\.target\.value\)/);
  assert.doesNotMatch(primaryScreenSource, /onCustomText\(.*\.trim\(\)\)/);
  assert.match(css, /\.mapping-field-trigger\s*\{/);
  assert.match(css, /\.mapping-fixed-input\s*\{/);
});
