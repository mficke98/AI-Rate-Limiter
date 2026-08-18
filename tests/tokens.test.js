import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, accountTokens } from '../src/tokens.js';

describe('estimateTokens', () => {
  test('returns 0 for empty or non-string input', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(42), 0);
  });

  test('never returns 0 for non-empty text, so no request is free', () => {
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('ab'), 1);
  });

  test('approximates 4 characters per token', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcdefgh'), 2);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });

  test('ignores surrounding whitespace', () => {
    assert.equal(estimateTokens('   abcd   '), estimateTokens('abcd'));
  });

  test('grows monotonically with input length', () => {
    let previous = 0;
    for (let n = 1; n <= 200; n += 7) {
      const current = estimateTokens('x'.repeat(n));
      assert.ok(current >= previous, 'expected non-decreasing token count');
      previous = current;
    }
  });
});

describe('accountTokens', () => {
  test('sums prompt and completion tokens', () => {
    const result = accountTokens('abcdefgh', 'abcd');
    assert.deepEqual(result, { prompt: 2, completion: 1, total: 3 });
  });

  test('treats a missing completion as zero', () => {
    const result = accountTokens('abcd');
    assert.equal(result.completion, 0);
    assert.equal(result.total, result.prompt);
  });
});
