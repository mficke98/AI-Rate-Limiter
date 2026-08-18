import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter, Decision } from '../src/rateLimiter.js';
import { createConfig } from '../src/config.js';

/**
 * All tests drive an injected clock rather than real time (decision D5).
 * This makes window-expiry behaviour deterministic and keeps the suite fast --
 * no sleeping, no flakes.
 */
function build(overrides = {}) {
  let clock = 1_000_000;
  const config = createConfig({
    rateLimit: {
      windowMs: 60_000,
      softMaxRequests: 5,
      hardMaxRequests: 15,
      softMaxTokens: 2_000,
      hardMaxTokens: 6_000,
      ...overrides,
    },
  }).rateLimit;
  const limiter = new SlidingWindowRateLimiter({ config, now: () => clock });
  return {
    limiter,
    config,
    advance: (ms) => { clock += ms; },
  };
}

describe('SlidingWindowRateLimiter - request budget', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('allows requests strictly below the soft limit', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(ctx.limiter.check(1).decision, Decision.ALLOW);
      ctx.limiter.record(1);
    }
  });

  test('degrades rather than rejecting once the soft limit is reached', () => {
    for (let i = 0; i < 5; i++) ctx.limiter.record(1);
    const verdict = ctx.limiter.check(1);
    assert.equal(verdict.decision, Decision.DEGRADE);
    assert.equal(verdict.reason, 'soft_request_limit_exceeded');
  });

  test('rejects once the hard limit is reached', () => {
    for (let i = 0; i < 15; i++) ctx.limiter.record(1);
    const verdict = ctx.limiter.check(1);
    assert.equal(verdict.decision, Decision.REJECT);
    assert.equal(verdict.reason, 'hard_request_limit_exceeded');
  });

  test('stays in DEGRADE across the whole band between soft and hard limits', () => {
    for (let i = 0; i < 5; i++) ctx.limiter.record(1);
    for (let i = 5; i < 15; i++) {
      assert.equal(ctx.limiter.check(1).decision, Decision.DEGRADE);
      ctx.limiter.record(1);
    }
    assert.equal(ctx.limiter.check(1).decision, Decision.REJECT);
  });
});

describe('SlidingWindowRateLimiter - token budget', () => {
  test('degrades when projected tokens cross the soft token limit', () => {
    const ctx = build();
    ctx.limiter.record(1_999);
    assert.equal(ctx.limiter.check(1).decision, Decision.DEGRADE);
    assert.equal(ctx.limiter.check(1).reason, 'soft_token_limit_exceeded');
  });

  test('rejects when projected tokens cross the hard token limit', () => {
    const ctx = build();
    ctx.limiter.record(5_999);
    const verdict = ctx.limiter.check(1);
    assert.equal(verdict.decision, Decision.REJECT);
    assert.equal(verdict.reason, 'hard_token_limit_exceeded');
  });

  test('counts the incoming estimate, not just recorded history', () => {
    const ctx = build();
    ctx.limiter.record(1_000);
    assert.equal(ctx.limiter.check(10).decision, Decision.ALLOW);
    assert.equal(ctx.limiter.check(1_000).decision, Decision.DEGRADE);
  });

  test('request limits take precedence over token limits in the reported reason', () => {
    const ctx = build();
    for (let i = 0; i < 15; i++) ctx.limiter.record(1);
    assert.equal(ctx.limiter.check(99_999).reason, 'hard_request_limit_exceeded');
  });
});

describe('SlidingWindowRateLimiter - window sliding', () => {
  test('frees capacity once entries age out of the window', () => {
    const ctx = build();
    for (let i = 0; i < 5; i++) ctx.limiter.record(1);
    assert.equal(ctx.limiter.check(1).decision, Decision.DEGRADE);

    ctx.advance(60_001);
    assert.equal(ctx.limiter.check(1).decision, Decision.ALLOW);
    assert.deepEqual(ctx.limiter.usage(), { requests: 0, tokens: 0 });
  });

  test('expires entries individually, not as a whole block', () => {
    const ctx = build();
    ctx.limiter.record(1);
    ctx.advance(30_000);
    for (let i = 0; i < 4; i++) ctx.limiter.record(1);
    assert.equal(ctx.limiter.usage().requests, 5);

    ctx.advance(30_001);
    assert.equal(ctx.limiter.usage().requests, 4);
    assert.equal(ctx.limiter.check(1).decision, Decision.ALLOW);
  });

  test('prevents the fixed-window boundary burst', () => {
    // A fixed window would allow 5 at the end of one minute and 5 more at the
    // start of the next. A sliding window must not.
    const ctx = build();
    for (let i = 0; i < 5; i++) ctx.limiter.record(1);
    ctx.advance(1_000);
    assert.equal(ctx.limiter.check(1).decision, Decision.DEGRADE);
  });
});

describe('SlidingWindowRateLimiter - Retry-After calculation', () => {
  test('reports 0 seconds when the window is empty', () => {
    const ctx = build();
    assert.equal(ctx.limiter.secondsUntilCapacity(), 0);
  });

  test('reports time until the oldest entry expires', () => {
    const ctx = build();
    ctx.limiter.record(1);
    ctx.advance(20_000);
    assert.equal(ctx.limiter.secondsUntilCapacity(), 40);
  });

  test('always reports at least 1 second while entries remain', () => {
    const ctx = build();
    ctx.limiter.record(1);
    ctx.advance(59_999);
    assert.equal(ctx.limiter.secondsUntilCapacity(), 1);
  });

  test('populates retryAfterSeconds only on REJECT verdicts', () => {
    const ctx = build();
    assert.equal(ctx.limiter.check(1).retryAfterSeconds, null);
    for (let i = 0; i < 15; i++) ctx.limiter.record(1);
    assert.ok(ctx.limiter.check(1).retryAfterSeconds > 0);
  });
});

describe('SlidingWindowRateLimiter - housekeeping', () => {
  test('reset clears all usage', () => {
    const ctx = build();
    for (let i = 0; i < 5; i++) ctx.limiter.record(100);
    ctx.limiter.reset();
    assert.deepEqual(ctx.limiter.usage(), { requests: 0, tokens: 0 });
    assert.equal(ctx.limiter.check(1).decision, Decision.ALLOW);
  });

  test('does not grow unboundedly as old entries expire', () => {
    const ctx = build({ windowMs: 1_000 });
    for (let i = 0; i < 500; i++) {
      ctx.limiter.record(1);
      ctx.advance(100);
    }
    assert.ok(ctx.limiter.entries.length <= 11, 'pruning should bound memory');
  });
});
