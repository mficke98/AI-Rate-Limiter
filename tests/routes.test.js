import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { BreakerState } from '../src/circuitBreaker.js';

/**
 * These tests drive a real HTTP server over a real socket on an ephemeral port.
 *
 * The unit suites already prove the state machines in isolation; the risk these
 * tests exist to cover is the wiring between them — headers, status codes, and
 * whether the metrics counters actually move when a request is served.
 */

/** Fast, tripwire-sensitive config so the suite stays quick and deterministic. */
const testConfig = {
  rateLimit: {
    windowMs: 60_000,
    softMaxRequests: 3,
    hardMaxRequests: 5,
    softMaxTokens: 100_000,
    hardMaxTokens: 200_000,
  },
  circuitBreaker: { failureThreshold: 2, cooldownMs: 200, successThreshold: 1 },
  models: {
    primary: { name: 'primary-model', latencyMs: 1, timeoutMs: 50, failureRate: 0 },
    secondary: { name: 'secondary-model', latencyMs: 1, timeoutMs: 50, failureRate: 0 },
  },
};

let ctx;

async function startServer(overrides = testConfig) {
  const { server, deps } = createServer(overrides);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    deps,
    base: `http://127.0.0.1:${port}`,
    generate: (body) =>
      fetch(`http://127.0.0.1:${port}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    metrics: () => fetch(`http://127.0.0.1:${port}/api/metrics`).then((r) => r.json()),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

beforeEach(async () => { ctx = await startServer(); });
afterEach(async () => { await ctx.close(); });

describe('POST /api/generate - validation', () => {
  test('rejects a missing prompt with 400', async () => {
    const res = await ctx.generate({});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request');
  });

  test('rejects a blank prompt with 400', async () => {
    const res = await ctx.generate({ prompt: '   ' });
    assert.equal(res.status, 400);
  });

  test('rejects a non-string prompt with 400', async () => {
    const res = await ctx.generate({ prompt: 42 });
    assert.equal(res.status, 400);
  });

  test('an invalid request does not consume the rate-limit budget', async () => {
    for (let i = 0; i < 5; i++) await ctx.generate({});
    const metrics = await ctx.metrics();
    assert.equal(metrics.requests.total, 0, 'malformed requests must not be counted');
    assert.equal(metrics.rateLimit.window.requests, 0);
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${ctx.base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'malformed_json');
  });
});

describe('POST /api/generate - happy path', () => {
  test('serves from the primary model with X-Fallback-Applied: false', async () => {
    const res = await ctx.generate({ prompt: 'What is the capital gains rate?' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-fallback-applied'), 'false');

    const body = await res.json();
    assert.equal(body.model, 'primary-model');
    assert.equal(body.fallbackApplied, false);
    assert.equal(body.fallbackReason, null);
    assert.equal(body.circuitBreaker, BreakerState.CLOSED);
  });

  test('reports token accounting for the exchange', async () => {
    const body = await (await ctx.generate({ prompt: 'a tax question' })).json();
    assert.ok(body.tokens.prompt > 0);
    assert.ok(body.tokens.completion > 0);
    assert.equal(body.tokens.total, body.tokens.prompt + body.tokens.completion);
  });
});

describe('POST /api/generate - soft limit degradation', () => {
  test('serves the first 3 requests from the primary, then degrades', async () => {
    for (let i = 0; i < 3; i++) {
      const body = await (await ctx.generate({ prompt: 'q' })).json();
      assert.equal(body.model, 'primary-model', `request ${i + 1}`);
    }

    const res = await ctx.generate({ prompt: 'q' });
    assert.equal(res.status, 200, 'over the soft limit the client is degraded, not refused');
    assert.equal(res.headers.get('x-fallback-applied'), 'true');

    const body = await res.json();
    assert.equal(body.model, 'secondary-model');
    assert.equal(body.fallbackReason, 'soft_request_limit_exceeded');
  });
});

describe('POST /api/generate - hard limit load shedding', () => {
  test('returns 429 with Retry-After once the hard limit is reached', async () => {
    for (let i = 0; i < 5; i++) await ctx.generate({ prompt: 'q' });

    const res = await ctx.generate({ prompt: 'q' });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);

    const body = await res.json();
    assert.equal(body.error, 'rate_limit_exceeded');
    assert.equal(body.reason, 'hard_request_limit_exceeded');
  });

  test('a shed request sets no fallback header, because no model was called', async () => {
    for (let i = 0; i < 5; i++) await ctx.generate({ prompt: 'q' });
    const res = await ctx.generate({ prompt: 'q' });
    assert.equal(res.headers.get('x-fallback-applied'), null);
  });

  test('shed requests are counted as rejected, not as fallbacks', async () => {
    for (let i = 0; i < 7; i++) await ctx.generate({ prompt: 'q' });
    const metrics = await ctx.metrics();
    assert.equal(metrics.requests.rejected, 2);
    assert.equal(metrics.requests.total, 7);
  });
});

describe('POST /api/generate - fallback on primary failure', () => {
  test('falls back to the secondary when the primary errors', async () => {
    const res = await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-fallback-applied'), 'true');

    const body = await res.json();
    assert.equal(body.model, 'secondary-model');
    assert.equal(body.fallbackReason, 'primary_error');
  });

  test('falls back to the secondary when the primary times out', async () => {
    const res = await ctx.generate({ prompt: 'q', simulate: { primaryLatencyMs: 500 } });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.model, 'secondary-model');
    assert.equal(body.fallbackReason, 'primary_timeout');
  });

  test('a timeout is recorded distinctly from a plain error', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryLatencyMs: 500 } });
    const metrics = await ctx.metrics();
    assert.equal(metrics.primary.timeouts, 1);
    assert.equal(metrics.fallback.reasons.primary_timeout, 1);
  });

  test('returns 503 - not 429 - when both models fail', async () => {
    const res = await ctx.generate({
      prompt: 'q',
      simulate: { primaryFails: 1, secondaryFails: 1 },
    });
    assert.equal(res.status, 503, 'total backend failure is not a rate-limit condition');
    assert.equal((await res.json()).error, 'all_backends_unavailable');
  });
});

describe('POST /api/generate - circuit breaker integration', () => {
  test('opens after consecutive primary failures and then skips the primary', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });

    const metrics = await ctx.metrics();
    assert.equal(metrics.circuitBreaker.state, BreakerState.OPEN);
    assert.equal(metrics.circuitBreaker.totalTrips, 1);
  });

  test('an OPEN breaker routes to fallback with reason circuit_open', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });

    const body = await (await ctx.generate({ prompt: 'q' })).json();
    assert.equal(body.model, 'secondary-model');
    assert.equal(body.fallbackReason, 'circuit_open',
      'with the breaker open the primary is skipped, not attempted and failed');
  });

  test('recovers to CLOSED after the cooldown once the primary succeeds', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    assert.equal((await ctx.metrics()).circuitBreaker.state, BreakerState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const body = await (await ctx.generate({ prompt: 'q' })).json();
    assert.equal(body.model, 'primary-model', 'the probe should reach the recovered primary');
    assert.equal((await ctx.metrics()).circuitBreaker.state, BreakerState.CLOSED);
  });
});

describe('GET /api/metrics', () => {
  test('exposes the four fields the brief requires', async () => {
    await ctx.generate({ prompt: 'q' });
    const metrics = await ctx.metrics();
    assert.equal(typeof metrics.requests.total, 'number');
    assert.equal(typeof metrics.tokens.total, 'number');
    assert.equal(typeof metrics.fallback.count, 'number');
    assert.ok([BreakerState.CLOSED, BreakerState.OPEN, BreakerState.HALF_OPEN]
      .includes(metrics.circuitBreaker.state));
  });

  test('token usage accumulates across requests', async () => {
    await ctx.generate({ prompt: 'first question' });
    const after1 = (await ctx.metrics()).tokens.total;
    await ctx.generate({ prompt: 'second question' });
    const after2 = (await ctx.metrics()).tokens.total;
    assert.ok(after2 > after1, 'tokens must accumulate, not reset');
  });

  test('separates primary-served from fallback-served counts', async () => {
    await ctx.generate({ prompt: 'q' });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });

    const metrics = await ctx.metrics();
    assert.equal(metrics.requests.servedByPrimary, 1);
    assert.equal(metrics.requests.servedByFallback, 1);
    assert.equal(metrics.fallback.count, 1);
  });

  test('reports current window usage against the configured limits', async () => {
    await ctx.generate({ prompt: 'q' });
    const metrics = await ctx.metrics();
    assert.equal(metrics.rateLimit.window.requests, 1);
    assert.equal(metrics.rateLimit.limits.softMaxRequests, 3);
    assert.equal(metrics.rateLimit.limits.hardMaxRequests, 5);
  });

  test('polling metrics does not consume the half-open probe', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 250));

    for (let i = 0; i < 5; i++) await ctx.metrics();

    const body = await (await ctx.generate({ prompt: 'q' })).json();
    assert.equal(body.model, 'primary-model',
      'a monitoring dashboard must not steal the probe opportunity');
  });

  test('is served with no-store so a dashboard never reads stale numbers', async () => {
    const res = await fetch(`${ctx.base}/api/metrics`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('POST /api/metrics/reset', () => {
  test('clears counters, the window, and the breaker', async () => {
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });
    await ctx.generate({ prompt: 'q', simulate: { primaryFails: 1 } });

    await fetch(`${ctx.base}/api/metrics/reset`, { method: 'POST' });

    const metrics = await ctx.metrics();
    assert.equal(metrics.requests.total, 0);
    assert.equal(metrics.tokens.total, 0);
    assert.equal(metrics.fallback.count, 0);
    assert.equal(metrics.circuitBreaker.state, BreakerState.CLOSED);
    assert.equal(metrics.rateLimit.window.requests, 0);
  });
});

describe('routing and transport', () => {
  test('unknown routes return 404 and list the available routes', async () => {
    const res = await fetch(`${ctx.base}/api/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not_found');
    assert.ok(body.routes.includes('POST /api/generate'));
  });

  test('the wrong method on a valid path is a 404, not a crash', async () => {
    const res = await fetch(`${ctx.base}/api/generate`);
    assert.equal(res.status, 404);
  });

  test('health check reports the breaker state', async () => {
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.circuitBreaker, BreakerState.CLOSED);
  });

  test('responses are valid JSON with the correct content type', async () => {
    const res = await ctx.generate({ prompt: 'q' });
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});
