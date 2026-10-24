import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import en from '../../../src/renderer/i18n/locales/en.json';
import th from '../../../src/renderer/i18n/locales/th.json';

type JsonTree = { readonly [key: string]: string | JsonTree };

function flatten(
  tree: JsonTree,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') {
      out[path] = value;
    } else {
      flatten(value, path, out);
    }
  }
  return out;
}

const enFlat = flatten(en);
const thFlat = flatten(th);

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.]+)\s*}}/g)].map((match) => match[1] ?? '').sort();
}

function rendererSources(): string[] {
  const root = join(process.cwd(), 'src', 'renderer');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(path);
    }
  };
  visit(root);
  return files;
}

const ACCESSIBLE_ATTRIBUTES = new Set([
  'aria-label',
  'title',
  'placeholder',
  'alt',
  'label',
  'description',
  'content',
]);

function hardcodedStrings(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const displayPath = relative(process.cwd(), file);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).trim();
      if (/[A-Za-z]{2,}/.test(text)) violations.push(`${displayPath}: ${text}`);
    }

    if (ts.isJsxExpression(node) && node.expression !== undefined) {
      const expression = node.expression;
      if (ts.isStringLiteral(expression) && /[A-Za-z]{2,}/.test(expression.text)) {
        violations.push(`${displayPath}: {'${expression.text}'}`);
      }
    }

    if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const name = node.name.getText(sourceFile);
      if (
        ACCESSIBLE_ATTRIBUTES.has(name) &&
        ts.isStringLiteral(node.initializer) &&
        /[A-Za-z]{2,}/.test(node.initializer.text)
      ) {
        violations.push(`${displayPath}: ${name}="${node.initializer.text}"`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('renderer translations', () => {
  it('keeps English and Thai keys in sync', () => {
    expect(Object.keys(thFlat)).toEqual(Object.keys(enFlat));
  });

  it('keeps interpolation placeholders in sync', () => {
    for (const [key, english] of Object.entries(enFlat)) {
      expect(placeholders(thFlat[key] ?? ''), key).toEqual(placeholders(english));
    }
  });

  it('uses only the _other plural suffix for Thai', () => {
    for (const key of Object.keys(thFlat)) {
      expect(key).not.toMatch(/_(one|few|many|two|zero)$/);
    }
  });

  it('resolves every translation-like string literal used by the renderer', () => {
    const topLevel = new Set(Object.keys(en));
    const pattern = /['"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)['"]/g;
    const used = new Set<string>();

    for (const file of rendererSources()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) {
        const key = match[1];
        if (key !== undefined && topLevel.has(key.split('.')[0] ?? '')) used.add(key);
      }
    }

    expect(used.size).toBeGreaterThan(50);
    for (const key of used) {
      expect(enFlat[key], `missing English key: ${key}`).toBeDefined();
      expect(thFlat[key], `missing Thai key: ${key}`).toBeDefined();
    }
  });

  it('has no hardcoded English text nodes or accessible labels in components', () => {
    const violations = rendererSources().flatMap((file) => hardcodedStrings(file));
    expect(violations).toEqual([]);
  });
});
