import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyDeterministicFixes, assessTranslationQuality } from '../worker/index.js';

// Regression for GH #101 ("[obs] queue translate error ... [ja]: Cannot read
// properties of undefined (reading 'toLowerCase')", 1858 occurrences).
//
// On the ja path the translation model rejects JSON Schema structured output,
// so buildTranslationRecord falls back to parsing free-form JSON. A free-form
// LLM response can omit fields or return non-strings (null, numbers, nested
// objects). applyDeterministicFixes / assessTranslationQuality then called
// .replace()/.split()/.includes()/.toLowerCase() on those values and threw,
// failing every ja job. The pipeline must now coerce defensively instead.

const jaRow = {
  id: 1,
  csp: 'aws',
  url: 'https://example.com/a',
  pub_date: '2026-10-01 00:00:00',
  title_en: 'AWS Lambda now supports Python 3.13 runtime',
  description_en: 'Customers can now create and update Lambda functions using Python 3.13.',
};

describe('translation pipeline tolerates malformed LLM fields (GH #101)', () => {
  test('applyDeterministicFixes does not throw on undefined/null/number/object fields', () => {
    const malformed = {
      title: undefined,
      summary: null,
      target: 42,
      features: { not: 'a string' },
      regions: null,
      status: [null, 123, { x: 1 }],
    };
    let fixed;
    assert.doesNotThrow(() => {
      fixed = applyDeterministicFixes(malformed, jaRow, 'ja');
    });
    // Every returned text field must be a string the persist/validate steps can use.
    assert.equal(typeof fixed.title, 'string');
    assert.equal(typeof fixed.summary, 'string');
    assert.equal(typeof fixed.target, 'string');
    assert.equal(typeof fixed.features, 'string');
    assert.equal(typeof fixed.status, 'string');
  });

  test('assessTranslationQuality does not throw on missing/non-string fields', () => {
    const malformed = { title: undefined, summary: null, target: 7, features: null, regions: null, status: undefined };
    let quality;
    assert.doesNotThrow(() => {
      quality = assessTranslationQuality(malformed, jaRow, 'ja');
    });
    // A malformed record is low quality, never a pass.
    assert.equal(quality.pass, false);
    assert.ok(quality.reasons.includes('missing-core-fields'));
  });

  test('status array with non-string elements is normalized without throwing', () => {
    const record = {
      title: 'AWS Lambda Python 3.13 サポート',
      summary: 'AWS LambdaでPython 3.13ランタイムが利用可能になりました。既存の関数をアップグレードして新機能を利用できます。',
      target: 'バックエンド開発者',
      features: '機能A, 機能B, 機能C',
      regions: 'すべてのAWSリージョン',
      status: ['一般提供', null, 999],
    };
    let fixed;
    assert.doesNotThrow(() => {
      fixed = applyDeterministicFixes(record, jaRow, 'ja');
    });
    const parsed = JSON.parse(fixed.status);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.includes('一般提供'));
  });
});
