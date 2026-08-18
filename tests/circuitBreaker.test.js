import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BreakerState } from '../src/circuitBreaker.js';
import { createConfig } from '../src/config.js';

/** Injected clock (decision D9) so cooldown expiry is instant and deterministic. */
function build(overrides = {}) {
  let clock = 1_000_000;
  const config = createConfig({
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 10_000,
      successThreshold: 2,
      ...overrides,
    },
  }).circuitBreaker;
  const breaker = new CircuitBreaker({ config, now: () => clock });
  return { breaker, config, advance: (ms) => { clock += ms; } };
}

/** Drive a breaker to OPEN by failing it past the threshold. */
function trip(breaker, times = 3) {
  for (let i = 0; i < times; i++) breaker.recordFailure(new Error('upstream down'));
}

describe('CircuitBreaker - initial state', () => {
  test('starts CLOSED and allows the primary', () => {
    const { breaker } = build();
    assert.equal(breaker.state, BreakerState.CLOSED);
    assert.equal(breaker.allowsPrimary(), true);
    assert.equal(breaker.snapshot().totalTrips, 0);
  });
});

describe('CircuitBreaker - CLOSED to OPEN', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('stays CLOSED below the failure threshold', () => {
    ctx.breaker.recordFailure(new Error('one'));
    ctx.breaker.recordFailure(new Error('two'));
    assert.equal(ctx.breaker.state, BreakerState.CLOSED);
    assert.equal(ctx.breaker.allowsPrimary(), true);
  });

  test('trips OPEN exactly at the failure threshold', () => {
    trip(ctx.breaker, 3);
    assert.equal(ctx.breaker.state, BreakerState.OPEN);
    assert.equal(ctx.breaker.allowsPrimary(), false);
    assert.equal(ctx.breaker.snapshot().totalTrips, 1);
  });

  test('counts consecutive failures only - a success resets the count', () => {
    ctx.breaker.recordFailure(new Error('one'));
    ctx.breaker.recordFailure(new Error('two'));
    ctx.breaker.recordSuccess();
    ctx.breaker.recordFailure(new Error('three'));
    ctx.breaker.recordFailure(new Error('four'));
    assert.equal(ctx.breaker.state, BreakerState.CLOSED,
      'intermittent failures must not trip the breaker');
  });

  test('retains the last error message for diagnostics', () => {
    ctx.breaker.recordFailure(new Error('primary-model timed out after 1000ms'));
    assert.match(ctx.breaker.snapshot().lastError, /timed out/);
  });
});

describe('CircuitBreaker - OPEN behaviour', () => {
  test('blocks the primary for the whole cooldown', () => {
    const ctx = build();
    trip(ctx.breaker);
    ctx.advance(9_999);
    assert.equal(ctx.breaker.allowsPrimary(), false);
    assert.equal(ctx.breaker.state, BreakerState.OPEN);
  });

  test('moves to HALF_OPEN once the cooldown elapses', () => {
    const ctx = build();
    trip(ctx.breaker);
    ctx.advance(10_000);
    assert.equal(ctx.breaker.allowsPrimary(), true);
    assert.equal(ctx.breaker.state, BreakerState.HALF_OPEN);
  });

  test('reports remaining cooldown so clients can see recovery approaching', () => {
    const ctx = build();
    trip(ctx.breaker);
    assert.equal(ctx.breaker.snapshot().cooldownRemainingMs, 10_000);
    ctx.advance(4_000);
    assert.equal(ctx.breaker.snapshot().cooldownRemainingMs, 6_000);
  });

  test('snapshot is side-effect free - reading does not trigger the probe', () => {
    const ctx = build();
    trip(ctx.breaker);
    ctx.advance(20_000);
    assert.equal(ctx.breaker.snapshot().state, BreakerState.OPEN,
      'a read-only metrics call must not transition the breaker');
    assert.equal(ctx.breaker.allowsPrimary(), true);
    assert.equal(ctx.breaker.state, BreakerState.HALF_OPEN);
  });
});

describe('CircuitBreaker - HALF_OPEN recovery', () => {
  /** Trip, then wait out the cooldown and probe into HALF_OPEN. */
  function halfOpen(overrides) {
    const ctx = build(overrides);
    trip(ctx.breaker);
    ctx.advance(10_000);
    ctx.breaker.allowsPrimary();
    assert.equal(ctx.breaker.state, BreakerState.HALF_OPEN);
    return ctx;
  }

  test('needs successThreshold consecutive successes to close', () => {
    const ctx = halfOpen();
    ctx.breaker.recordSuccess();
    assert.equal(ctx.breaker.state, BreakerState.HALF_OPEN, 'one success is not enough');
    ctx.breaker.recordSuccess();
    assert.equal(ctx.breaker.state, BreakerState.CLOSED);
  });

  test('a single failure while probing re-opens immediately', () => {
    const ctx = halfOpen();
    ctx.breaker.recordSuccess();
    ctx.breaker.recordFailure(new Error('still down'));
    assert.equal(ctx.breaker.state, BreakerState.OPEN);
    assert.equal(ctx.breaker.snapshot().totalTrips, 2);
  });

  test('re-opening restarts the full cooldown', () => {
    const ctx = halfOpen();
    ctx.breaker.recordFailure(new Error('still down'));
    assert.equal(ctx.breaker.snapshot().cooldownRemainingMs, 10_000);
    ctx.advance(9_999);
    assert.equal(ctx.breaker.allowsPrimary(), false);
  });

  test('closing clears the failure counter, so recovery is a clean slate', () => {
    const ctx = halfOpen();
    ctx.breaker.recordSuccess();
    ctx.breaker.recordSuccess();
    const snap = ctx.breaker.snapshot();
    assert.equal(snap.state, BreakerState.CLOSED);
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(snap.openedAt, null);
  });

  test('survives a full trip-recover-trip cycle', () => {
    const ctx = build();
    trip(ctx.breaker);
    assert.equal(ctx.breaker.state, BreakerState.OPEN);

    ctx.advance(10_000);
    ctx.breaker.allowsPrimary();
    ctx.breaker.recordSuccess();
    ctx.breaker.recordSuccess();
    assert.equal(ctx.breaker.state, BreakerState.CLOSED);

    trip(ctx.breaker);
    assert.equal(ctx.breaker.state, BreakerState.OPEN);
    assert.equal(ctx.breaker.snapshot().totalTrips, 2);
  });
});

describe('CircuitBreaker - configuration sensitivity', () => {
  test('honours a custom failure threshold', () => {
    const ctx = build({ failureThreshold: 1 });
    ctx.breaker.recordFailure(new Error('boom'));
    assert.equal(ctx.breaker.state, BreakerState.OPEN);
  });

  test('honours a custom success threshold of 1', () => {
    const ctx = build({ successThreshold: 1 });
    trip(ctx.breaker);
    ctx.advance(10_000);
    ctx.breaker.allowsPrimary();
    ctx.breaker.recordSuccess();
    assert.equal(ctx.breaker.state, BreakerState.CLOSED);
  });
});

describe('CircuitBreaker - housekeeping', () => {
  test('reset returns the breaker to a healthy CLOSED state', () => {
    const ctx = build();
    trip(ctx.breaker);
    ctx.breaker.reset();
    const snap = ctx.breaker.snapshot();
    assert.equal(snap.state, BreakerState.CLOSED);
    assert.equal(snap.totalTrips, 0);
    assert.equal(snap.lastError, null);
    assert.equal(ctx.breaker.allowsPrimary(), true);
  });
});
