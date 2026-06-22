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
const primaryScreenPartsSource = readFileSync(
  new URL('../../src/components/document-generator/PrimaryScreenParts.tsx', import.meta.url),
  'utf8',
);
const primaryScreenUiSource = primaryScreenSource + primaryScreenPartsSource;

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
const pickerScreenSource = readFileSync(
  new URL('../../src/components/document-generator/PickerScreen.tsx', import.meta.url),
  'utf8',
);
const primaryScreenTemplateSource = readFileSync(
  new URL('../../src/components/document-generator/PrimaryScreen.tsx', import.meta.url),
  'utf8',
);
const newTemplateScreenSource = readFileSync(
  new URL('../../src/components/document-generator/NewTemplateScreen.tsx', import.meta.url),
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
  assert.match(primaryScreenUiSource, /mapping-mode-switch/);
  assert.match(primaryScreenUiSource, /mapping-field-search/);
  assert.match(primaryScreenUiSource, /mapping-fixed-input/);
  assert.match(primaryScreenUiSource, /固定值/);
  assert.match(primaryScreenUiSource, /onCustomText\(e\.target\.value\)/);
  assert.doesNotMatch(primaryScreenUiSource, /onCustomText\(.*\.trim\(\)\)/);
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

test('默认缺失变量策略为留空继续，避免空单元格直接生成失败', () => {
  assert.match(documentGeneratorAppSource, /onMissing:\s*'留空继续'/);
});

test('模板 ID 复制入口必须带可见文案和复制反馈', () => {
  assert.doesNotMatch(generatorHeaderSource, /Icon\.Help/);
  assert.match(primaryScreenTemplateSource, /template-copy-btn/);
  assert.match(primaryScreenTemplateSource, /复制ID/);
  assert.match(primaryScreenTemplateSource, /copyTextToClipboard/);
  assert.match(pickerScreenSource, /template-copy-btn/);
  assert.match(pickerScreenSource, /复制ID/);
  assert.match(pickerScreenSource, /copyTextToClipboard/);
  assert.match(css, /\.template-copy-btn/);
  assert.match(css, /\.nt-id-card\s*\{/);
});

test('模板库必须支持更新现有模板，而不是只能新建模板', () => {
  assert.match(primaryScreenTemplateSource, /onEditTemplate/);
  assert.match(primaryScreenTemplateSource, /更新模板/);
  assert.match(pickerScreenSource, /onEdit/);
  assert.match(pickerScreenSource, /template-card-actions/);
  assert.match(pickerScreenSource, /更新/);
  assert.match(newTemplateScreenSource, /\/versions/);
  assert.match(newTemplateScreenSource, /保存新版本/);
  assert.match(newTemplateScreenSource, /模板 ID 保持不变/);
  assert.match(css, /\.template-card-actions\s*\{/);
});

test('新建模板表单在窄侧边栏内使用纵向表单布局，不退回浏览器默认控件', () => {
  assert.match(newTemplateScreenSource, /className="nt-field"/);
  assert.match(newTemplateScreenSource, /className="nt-input"/);
  assert.match(newTemplateScreenSource, /合同类/);
  assert.match(css, /\.nt-field\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.nt-input\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*36px;/);
  assert.match(css, /\.nt-segment\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/);
});

test('FBIF 品牌图使用原图比例显示，不能被压成方形占位图', () => {
  assert.match(generatorHeaderSource, /<img className="hdr-logo" src="\/fbif-logo\.webp" alt="FBIF" \/>/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*28px;/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?object-fit:\s*contain;/);
  assert.match(css, /\.hdr-logo\s*\{[\s\S]*?background:\s*transparent;/);
});
