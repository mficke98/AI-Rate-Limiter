import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsStore } from '../src/metrics.js';
import { BreakerState } from '../src/circuitBreaker.js';

const stubSnapshotParts = {
  breaker: { state: BreakerState.CLOSED, totalTrips: 0 },
  window: { requests: 0, tokens: 0 },
  limits: { softMaxRequests: 5, hardMaxRequests: 15 },
};

describe('MetricsStore - counters', () => {
  let metrics;
  beforeEach(() => { metrics = new MetricsStore(); });

  test('starts at zero across the board', () => {
    const snap = metrics.snapshot(stubSnapshotParts);
    assert.deepEqual(snap.requests, {
      total: 0, servedByPrimary: 0, servedByFallback: 0, rejected: 0, failed: 0,
    });
    assert.equal(snap.tokens.total, 0);
    assert.equal(snap.fallback.count, 0);
  });

  test('counts every request that reaches the proxy', () => {
    for (let i = 0; i < 7; i++) metrics.recordRequest();
    assert.equal(metrics.snapshot(stubSnapshotParts).requests.total, 7);
  });

  test('separates primary, fallback, rejected, and failed outcomes', () => {
    metrics.recordPrimarySuccess(100);
    metrics.recordFallback('primary_error', 40);
    metrics.recordRejected();
    metrics.recordTotalFailure();

    const { requests } = metrics.snapshot(stubSnapshotParts);
    assert.equal(requests.servedByPrimary, 1);
    assert.equal(requests.servedByFallback, 1);
    assert.equal(requests.rejected, 1);
    assert.equal(requests.failed, 1);
  });

  test('accumulates prompt, completion, and total tokens independently', () => {
    metrics.recordTokens({ prompt: 10, completion: 5, total: 15 });
    metrics.recordTokens({ prompt: 4, completion: 1, total: 5 });
    assert.deepEqual(metrics.snapshot(stubSnapshotParts).tokens,
      { prompt: 14, completion: 6, total: 20 });
  });

  test('tracks primary errors and timeouts separately', () => {
    metrics.recordPrimaryFailure({ timedOut: false });
    metrics.recordPrimaryFailure({ timedOut: true });
    const { primary } = metrics.snapshot(stubSnapshotParts);
    assert.equal(primary.errors, 2);
    assert.equal(primary.timeouts, 1, 'a timeout is one specific kind of error');
  });
});

describe('MetricsStore - fallback breakdown', () => {
  let metrics;
  beforeEach(() => { metrics = new MetricsStore(); });

  test('attributes each fallback to its cause', () => {
    metrics.recordFallback('soft_request_limit_exceeded');
    metrics.recordFallback('soft_request_limit_exceeded');
    metrics.recordFallback('circuit_open');

    const { reasons, count } = metrics.snapshot(stubSnapshotParts).fallback;
    assert.equal(count, 3);
    assert.equal(reasons.soft_request_limit_exceeded, 2);
    assert.equal(reasons.circuit_open, 1);
    assert.equal(reasons.primary_timeout, 0);
  });

  test('ignores an unrecognised reason without corrupting the total', () => {
    metrics.recordFallback('not_a_real_reason');
    const { count, reasons } = metrics.snapshot(stubSnapshotParts).fallback;
    assert.equal(count, 1);
    assert.equal(reasons.not_a_real_reason, undefined);
  });

  test('fallback rate is 0 when nothing has been served', () => {
    assert.equal(metrics.snapshot(stubSnapshotParts).fallback.rate, 0);
  });

  test('fallback rate is the share of served requests using the secondary', () => {
    metrics.recordPrimarySuccess(10);
    metrics.recordPrimarySuccess(10);
    metrics.recordPrimarySuccess(10);
    metrics.recordFallback('circuit_open', 5);
    assert.equal(metrics.snapshot(stubSnapshotParts).fallback.rate, 0.25);
  });

  test('rejected requests are excluded from the fallback rate denominator', () => {
    metrics.recordPrimarySuccess(10);
    metrics.recordFallback('circuit_open', 5);
    metrics.recordRejected();
    assert.equal(metrics.snapshot(stubSnapshotParts).fallback.rate, 0.5,
      'a shed request was never served, so it cannot dilute the rate');
  });
});

describe('MetricsStore - averages', () => {
  test('average latency is 0 with no samples, not NaN', () => {
    const metrics = new MetricsStore();
    const snap = metrics.snapshot(stubSnapshotParts);
    assert.equal(snap.primary.avgLatencyMs, 0);
    assert.equal(snap.secondary.avgLatencyMs, 0);
  });

  test('averages latency across recorded calls', () => {
    const metrics = new MetricsStore();
    metrics.recordPrimarySuccess(100);
    metrics.recordPrimarySuccess(200);
    metrics.recordFallback('circuit_open', 40);
    metrics.recordFallback('circuit_open', 60);
    const snap = metrics.snapshot(stubSnapshotParts);
    assert.equal(snap.primary.avgLatencyMs, 150);
    assert.equal(snap.secondary.avgLatencyMs, 50);
  });
});

describe('MetricsStore - snapshot composition', () => {
  test('passes the breaker state through untouched', () => {
    const metrics = new MetricsStore();
    const snap = metrics.snapshot({
      ...stubSnapshotParts,
      breaker: { state: BreakerState.OPEN, totalTrips: 3 },
    });
    assert.equal(snap.circuitBreaker.state, 'OPEN');
    assert.equal(snap.circuitBreaker.totalTrips, 3);
  });

  test('reports current window usage alongside the configured limits', () => {
    const metrics = new MetricsStore();
    const snap = metrics.snapshot({
      ...stubSnapshotParts,
      window: { requests: 4, tokens: 320 },
    });
    assert.deepEqual(snap.rateLimit.window, { requests: 4, tokens: 320 });
    assert.equal(snap.rateLimit.limits.softMaxRequests, 5);
  });

  test('exposes the four fields the brief requires', () => {
    const metrics = new MetricsStore();
    const snap = metrics.snapshot(stubSnapshotParts);
    assert.ok('total' in snap.requests, 'total requests');
    assert.ok('total' in snap.tokens, 'tokens used');
    assert.ok('count' in snap.fallback, 'fallback count');
    assert.ok('state' in snap.circuitBreaker, 'circuit breaker status');
  });

  test('reports a non-negative uptime', () => {
    const metrics = new MetricsStore();
    assert.ok(metrics.snapshot(stubSnapshotParts).uptimeMs >= 0);
  });
});

describe('MetricsStore - reset', () => {
  test('clears every counter', () => {
    const metrics = new MetricsStore();
    metrics.recordRequest();
    metrics.recordPrimarySuccess(50);
    metrics.recordFallback('circuit_open', 10);
    metrics.recordTokens({ prompt: 5, completion: 5, total: 10 });

    metrics.reset();
    const snap = metrics.snapshot(stubSnapshotParts);
    assert.equal(snap.requests.total, 0);
    assert.equal(snap.tokens.total, 0);
    assert.equal(snap.fallback.count, 0);
    assert.equal(snap.fallback.reasons.circuit_open, 0);
  });
});
