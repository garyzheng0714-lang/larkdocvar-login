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

const progressModalSource = readFileSync(
  new URL('../../src/components/document-generator/ProgressModal.tsx', import.meta.url),
  'utf8',
);

const documentGeneratorAppSource = readFileSync(
  new URL('../../src/components/document-generator/DocumentGeneratorApp.tsx', import.meta.url),
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

test('生成进度弹窗的当前结构都有样式，完成后不能退化成裸文本', () => {
  for (const className of [
    'bar-wrap',
    'bar-track',
    'bar-fill',
    'bar-pct',
    'stat-strip',
    'rec-list',
    'rec-scroll',
    'rec-row',
    'rec-status',
    'confirm-scrim',
    'confirm',
    'confirm-title',
    'confirm-text',
    'confirm-ftr',
  ]) {
    assert.match(progressModalSource, new RegExp(`className=["'{}+()\\s]*${className}`));
    assert.match(css, new RegExp(`\\.${className}\\s*\\{`));
  }
});

test('失败记录必须直接显示失败原因，不能只藏在 hover title 里', () => {
  assert.match(progressModalSource, /className="rec-error"/);
  assert.match(progressModalSource, /\{item\.error\}/);
  assert.match(css, /\.rec-error\s*\{/);
});

test('默认缺失变量策略保持严格，避免静默生成空文档', () => {
  assert.match(documentGeneratorAppSource, /onMissing:\s*'停止该条'/);
});

test('当前视图没有记录时不能开始生成，避免用户误以为已经提交', () => {
  assert.match(primaryScreenSource, /hasRecords/);
  assert.match(primaryScreenSource, /state\.selectedCount\s*>\s*0/);
  assert.match(primaryScreenSource, /没有可生成记录/);
});

test('缺失变量原因区分未选字段、固定值为空和当前记录字段值为空', () => {
  assert.match(progressModalSource, /className="rec-error"/);
  assert.match(progressModalSource, /\{item\.error\}/);
  assert.match(css, /\.rec-error\s*\{/);
  assert.match(
    readFileSync(new URL('../../src/components/document-generator/useGenerate.ts', import.meta.url), 'utf8'),
    /当前记录中「\$\{v\.name\}」对应字段的值为空/,
  );
});

test('侧边栏不渲染无效图标按钮，避免用户点击后没有反馈', () => {
  assert.doesNotMatch(generatorHeaderSource, /Icon\.Help/);
  assert.doesNotMatch(primaryScreenSource, /template-copy-btn|copyText|Icon\.Copy/);
  assert.doesNotMatch(
    readFileSync(new URL('../../src/components/document-generator/PickerScreen.tsx', import.meta.url), 'utf8'),
    /template-copy-btn|copyText|Icon\.Copy/,
  );
});

test('FBIF 品牌图使用原图比例显示，不能被压成方形占位图', () => {
  assert.match(generatorHeaderSource, /<img className="hdr-logo" src="\/fbif-logo\.webp" alt="FBIF" \/>/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*28px;/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?object-fit:\s*contain;/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?background:\s*transparent;/);
});
