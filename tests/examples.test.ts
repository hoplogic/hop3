// @module: spec-parser ^anc-struct-spec-parser
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSpec } from '../src/parser.js';
import { validateSpec } from '../src/validator.js';

const ROOT = resolve(import.meta.dirname, '..');

describe('published examples', () => {
  it('data-quality demo is valid and its promised z-score outlier is observable', () => {
    const specText = readFileSync(resolve(ROOT, 'examples/data-quality.md'), 'utf-8');
    const { ast, errors } = parseSpec(specText);
    expect(errors).toEqual([]);
    expect(validateSpec(ast).filter(issue => issue.severity === 'error')).toEqual([]);

    const rows = JSON.parse(readFileSync(resolve(ROOT, 'examples/demo-data.json'), 'utf-8')) as Array<Record<string, unknown>>;
    const amounts = rows
      .map(row => row.amount)
      .filter((value): value is number => typeof value === 'number');
    const mean = amounts.reduce((sum, value) => sum + value, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / amounts.length);
    const outliers = amounts.filter(value => Math.abs((value - mean) / sd) > 3);

    expect(outliers).toEqual([99000]);
    expect(specText).toContain('quality_score = (completeness + outlier_free + consistency) / 3');
    expect(specText).toContain('row_retention = len(clean_data) / len(raw_data)');
  });
});
