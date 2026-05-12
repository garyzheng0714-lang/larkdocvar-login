import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type TemplateEntry = {
  name: string;
  category: string;
  covers: string[];
  expectedVariables: string[];
};

type TemplateManifest = {
  templates: TemplateEntry[];
};

function extractTemplateSource(source: string, name: string): string {
  const start = source.indexOf(`name: '${name}'`);
  assert.notEqual(start, -1, name);
  const next = source.indexOf("    { name: '", start + name.length);
  const end = next === -1 ? source.indexOf('  ];', start) : next;
  assert.notEqual(end, -1, name);
  return source.slice(start, end);
}

function extractVariablesFromTemplateSource(templateSource: string): Set<string> {
  const variables = new Set<string>();
  const placeholderPattern = /\{\{([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = placeholderPattern.exec(templateSource)) !== null) {
    const normalizedName = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\\[rnt]/g, '')
      .trim();
    if (normalizedName) variables.add(normalizedName);
  }
  return variables;
}

test('Docx 回归模板库 manifest 覆盖 20 个已执行模板', async () => {
  const manifest = JSON.parse(
    await readFile('docs/docx-regression-template-library.json', 'utf8'),
  ) as TemplateManifest;
  const source = await readFile('server/src/documentRenderApi.test.ts', 'utf8');
  const names = manifest.templates.map((template) => template.name);
  const categories = new Set(manifest.templates.map((template) => template.category));
  const coverage = new Set(manifest.templates.flatMap((template) => template.covers));

  assert.equal(manifest.templates.length, 20);
  assert.equal(new Set(names).size, 20);
  for (const template of manifest.templates) {
    const templateSource = extractTemplateSource(source, template.name);
    const variables = extractVariablesFromTemplateSource(templateSource);
    assert.ok(template.category);
    assert.ok(template.covers.length > 0, template.name);
    assert.ok(template.expectedVariables.length > 0, template.name);
    assert.equal(new Set(template.expectedVariables).size, template.expectedVariables.length, template.name);
    assert.deepEqual(
      [...variables].sort(),
      [...template.expectedVariables].sort(),
      template.name,
    );
  }
  for (const requiredCategory of ['contract', 'quote', 'invitation', 'table', 'header-footer']) {
    assert.ok(categories.has(requiredCategory), requiredCategory);
  }
  for (const requiredCoverage of ['body', 'table', 'header', 'footer', 'split-run', 'style']) {
    assert.ok(coverage.has(requiredCoverage), requiredCoverage);
  }
});
