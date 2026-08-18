#!/usr/bin/env node
/**
 * End-to-end demonstration script.
 *
 * Starts a real proxy on an ephemeral port and drives it through every outcome
 * the system supports, printing what happened at each step. This is the
 * one-command proof that the proxy behaves as designed against real HTTP —
 * the unit suites prove the parts, this proves the whole.
 *
 * Run with:  node scripts/demo.js
 */

import { createServer } from '../src/server.js';

/** Small, fast limits so the whole demo runs in a couple of seconds. */
const demoConfig = {
  rateLimit: {
    windowMs: 60_000,
    softMaxRequests: 5,
    hardMaxRequests: 8,
    softMaxTokens: 100_000,
    hardMaxTokens: 200_000,
  },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, successThreshold: 1 },
  models: {
    primary: { name: 'primary-model', latencyMs: 20, timeoutMs: 200, failureRate: 0 },
    secondary: { name: 'secondary-model', latencyMs: 5, timeoutMs: 200, failureRate: 0 },
  },
};

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function section(title) {
  console.log(`\n${bold(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)}`);
}

/** Colour a one-line summary by what the proxy decided to do. */
function describe(status, body, headers) {
  if (status === 429) return red(`429 shed        · ${body.reason} · retry in ${body.retryAfterSeconds}s`);
  if (status === 503) return red(`503 unavailable · both models failed`);
  if (status === 400) return red(`400 rejected    · ${body.error}`);
  const fallback = headers.get('x-fallback-applied');
  if (fallback === 'true') {
    return yellow(`200 fallback    · ${body.model} · reason: ${body.fallbackReason}`);
  }
  return green(`200 primary     · ${body.model} · ${body.latencyMs}ms`);
}

async function main() {
  const { server } = createServer(demoConfig);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const generate = async (payload, label) => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    console.log(`  ${String(label).padEnd(30)} ${describe(res.status, body, res.headers)}`);
    return { status: res.status, body };
  };

  const metrics = () => fetch(`${base}/api/metrics`).then((r) => r.json());
  const reset = () => fetch(`${base}/api/metrics/reset`, { method: 'POST' });

  console.log(bold('\nAI Rate Limiter & Fallback Proxy — demonstration'));
  console.log(dim(`  soft limit ${demoConfig.rateLimit.softMaxRequests} req/min · ` +
    `hard limit ${demoConfig.rateLimit.hardMaxRequests} req/min · ` +
    `breaker trips after ${demoConfig.circuitBreaker.failureThreshold} failures`));

  // ---- Scenario 1: normal traffic ----------------------------------------
  section('1. Normal traffic is served by the primary model');
  for (let i = 1; i <= 3; i++) {
    await generate({ prompt: `Tax question ${i}: what is the AMT threshold?` }, `request ${i}`);
  }

  // ---- Scenario 2: soft limit --------------------------------------------
  section('2. Crossing the soft limit degrades to the secondary model');
  for (let i = 4; i <= 7; i++) {
    await generate({ prompt: `Tax question ${i}` }, `request ${i}`);
  }

  // ---- Scenario 3: hard limit --------------------------------------------
  section('3. Crossing the hard limit sheds load with 429');
  for (let i = 8; i <= 10; i++) {
    await generate({ prompt: `Tax question ${i}` }, `request ${i}`);
  }

  console.log(dim('\n  Load shedding protects the upstream gateway. Resetting to continue...'));
  await reset();

  // ---- Scenario 4: primary failure ---------------------------------------
  section('4. A failing primary model falls back automatically');
  await generate({ prompt: 'Question during an outage', simulate: { primaryFails: 1 } },
    'primary errors');
  await generate({ prompt: 'Question during a latency spike', simulate: { primaryLatencyMs: 500 } },
    'primary times out');

  // ---- Scenario 5: breaker trips -----------------------------------------
  section('5. Repeated failures trip the circuit breaker OPEN');
  await generate({ prompt: 'Third failure', simulate: { primaryFails: 1 } }, 'third failure');

  const tripped = await metrics();
  console.log(`  ${dim('breaker state:')} ${red(tripped.circuitBreaker.state)} ` +
    `${dim(`(trips: ${tripped.circuitBreaker.totalTrips})`)}`);

  await generate({ prompt: 'Served while the breaker is open' }, 'while OPEN');
  console.log(dim('  ^ the primary is skipped entirely — no timeout is paid'));

  // ---- Scenario 6: recovery ----------------------------------------------
  section('6. After the cooldown, the breaker probes and recovers');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await generate({ prompt: 'Probe request after cooldown' }, 'probe request');
  console.log(`  ${dim('breaker state:')} ${green((await metrics()).circuitBreaker.state)}`);

  // ---- Scenario 7: total failure -----------------------------------------
  section('7. If both models fail, the proxy returns 503 (not 429)');
  await generate(
    { prompt: 'Total outage', simulate: { primaryFails: 1, secondaryFails: 1 } },
    'both models down',
  );

  // ---- Final metrics ------------------------------------------------------
  section('Final metrics (GET /api/metrics)');
  const final = await metrics();
  console.log(JSON.stringify(
    {
      requests: final.requests,
      tokens: final.tokens,
      fallback: final.fallback,
      circuitBreaker: {
        state: final.circuitBreaker.state,
        totalTrips: final.circuitBreaker.totalTrips,
      },
    },
    null,
    2,
  ).split('\n').map((line) => `  ${line}`).join('\n'));

  console.log(green('\n✓ Demonstration complete — every outcome exercised.\n'));
  server.close();
}

main().catch((error) => {
  console.error(red(`Demo failed: ${error.stack ?? error}`));
  process.exit(1);
});
