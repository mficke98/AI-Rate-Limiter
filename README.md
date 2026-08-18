# AI Rate Limiter & Fallback Proxy

A zero-dependency Node.js proxy for an LLM gateway. It enforces a local sliding-window
request/token budget, trips a circuit breaker when the primary model fails or times out, and falls
back to a lightweight secondary model instead of dropping client requests.

**New here?** Read [`REPORT.md`](REPORT.md) first — it explains the problem and the solution in
plain language, no technical background needed.

---

## Quick start

No installation step. Node.js 20 or later is the only requirement.

```bash
node src/server.js
```

Run the full test suite (102 tests):

```bash
node --test tests/
```

Watch every scenario play out end to end:

```bash
node scripts/demo.js
```

---

## API reference

### `POST /api/generate`

Send a prompt. The proxy decides which model answers it.

**Request**
```json
{ "prompt": "What is the capital gains rate for a trust?" }
```

**Response** — `200 OK`
```json
{
  "model": "primary-model",
  "completion": "[primary-model] Detailed tax analysis for: ...",
  "fallbackApplied": false,
  "fallbackReason": null,
  "latencyMs": 132,
  "tokens": { "prompt": 11, "completion": 43, "total": 54 },
  "rateLimit": { "decision": "ALLOW", "usage": { "requests": 1, "tokens": 54 } },
  "circuitBreaker": "CLOSED"
}
```

**Every possible outcome**

| Condition | Backend | Status | `X-Fallback-Applied` |
|---|---|---|---|
| Within budget, primary healthy | `primary-model` | `200` | `false` |
| Over the soft limit (5 req/min) | `secondary-model` | `200` | `true` |
| Over the hard limit (15 req/min) | none — load shed | `429` + `Retry-After` | *(absent)* |
| Primary errored or timed out | `secondary-model` | `200` | `true` |
| Circuit breaker `OPEN` | `secondary-model` | `200` | `true` |
| Both models failed | none | `503` | `true` |
| Missing or malformed prompt | none | `400` | *(absent)* |

`fallbackReason` names the exact cause: `soft_request_limit_exceeded`,
`soft_token_limit_exceeded`, `primary_error`, `primary_timeout`, or `circuit_open`.

**Simulation controls** *(prototype only — see decision D4)*

An optional `simulate` object forces failure conditions on demand, which is what makes the
circuit breaker demonstrable and testable:

```json
{
  "prompt": "a question",
  "simulate": { "primaryFails": 1, "primaryLatencyMs": 500, "secondaryFails": 1 }
}
```

### `GET /api/metrics`

Live operational view. Strictly read-only — polling it can never alter proxy behaviour (D14).

```json
{
  "uptimeMs": 48213,
  "requests": { "total": 12, "servedByPrimary": 5, "servedByFallback": 5, "rejected": 1, "failed": 1 },
  "tokens": { "prompt": 88, "completion": 402, "total": 490 },
  "fallback": {
    "count": 5,
    "rate": 0.5,
    "reasons": {
      "soft_request_limit_exceeded": 2,
      "soft_token_limit_exceeded": 0,
      "primary_error": 2,
      "primary_timeout": 0,
      "circuit_open": 1
    }
  },
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0,
    "totalTrips": 1,
    "cooldownRemainingMs": 0,
    "lastError": "primary-model failed: upstream error"
  },
  "rateLimit": {
    "window": { "requests": 3, "tokens": 210 },
    "limits": { "windowMs": 60000, "softMaxRequests": 5, "hardMaxRequests": 15 }
  },
  "primary": { "errors": 2, "timeouts": 0, "avgLatencyMs": 128 },
  "secondary": { "avgLatencyMs": 42 }
}
```

### `POST /api/metrics/reset`

Clears all counters, the rate-limit window, and the circuit breaker. Makes demonstrations
repeatable — without it, hitting the hard limit locks the demo out for a full minute (D18).

### `GET /api/health`

Liveness probe. Returns `{ "ok": true, "circuitBreaker": "CLOSED" }`.

---

## Try it

```bash
curl -i -X POST http://localhost:3000/api/generate -H "Content-Type: application/json" -d "{\"prompt\":\"What is the capital gains rate?\"}"
```

Force a fallback and watch the header flip to `true`:

```bash
curl -i -X POST http://localhost:3000/api/generate -H "Content-Type: application/json" -d "{\"prompt\":\"test\",\"simulate\":{\"primaryFails\":1}}"
```

Read the live metrics:

```bash
curl http://localhost:3000/api/metrics
```

---

## Configuration

Every tunable lives in [`src/config.js`](src/config.js). The defaults:

| Setting | Default | Meaning |
|---|---|---|
| `rateLimit.windowMs` | `60000` | Width of the sliding window |
| `rateLimit.softMaxRequests` | `5` | Requests before degrading to the secondary model |
| `rateLimit.hardMaxRequests` | `15` | Requests before shedding load with a `429` |
| `rateLimit.softMaxTokens` | `2000` | Tokens before degrading |
| `rateLimit.hardMaxTokens` | `6000` | Tokens before shedding |
| `circuitBreaker.failureThreshold` | `3` | Consecutive failures that trip the breaker |
| `circuitBreaker.cooldownMs` | `10000` | How long the breaker stays `OPEN` before probing |
| `circuitBreaker.successThreshold` | `2` | Consecutive successes needed to close it again |

`PORT` is read from the environment; everything else is overridable programmatically via
`createServer({ ... })`.

---

## How it works

```
POST /api/generate
        │
        ▼
  ┌───────────────┐   over hard limit
  │ Rate limiter  │──────────────────────▶ 429 + Retry-After
  └───────┬───────┘
          │ within budget          over soft limit
          ▼                                │
  ┌───────────────┐  OPEN                  │
  │ Circuit       │────────────────────────┤
  │ breaker       │                        │
  └───────┬───────┘                        │
          │ CLOSED / HALF_OPEN             │
          ▼                                ▼
   ┌─────────────┐   fails/times out  ┌──────────────┐
   │   primary   │───────────────────▶│  secondary   │
   └──────┬──────┘                    └───────┬──────┘
          │ 200                               │ 200 + X-Fallback-Applied: true
          ▼                                   ▼        (503 if this fails too)
                      Metrics recorder ──▶ GET /api/metrics
```

Circuit breaker states:

- **`CLOSED`** — healthy, requests go to the primary model.
- **`OPEN`** — tripped after `failureThreshold` consecutive failures. The primary is skipped
  entirely, so no request pays its timeout.
- **`HALF_OPEN`** — after the cooldown, a probe request is allowed through. Enough successes close
  the breaker; a single failure re-opens it.

---

## Project layout

```
src/
  config.js            every tunable, in one place
  tokens.js            token estimation
  rateLimiter.js       sliding window over requests and tokens
  circuitBreaker.js    CLOSED / OPEN / HALF_OPEN state machine
  models.js            simulated primary and secondary backends
  metrics.js           counter store
  app.js               composition root
  server.js            HTTP transport (no business logic)
  routes/
    generate.js        the complete routing outcome table
    metrics.js         metrics read and reset
tests/                 102 tests across 5 suites
scripts/demo.js        end-to-end demonstration
docs/
  DECISIONS.md         D1-D23, with benefits, trade-offs, and the discussion behind each
  ARCHITECTURE.md      technical design
REPORT.md              plain-language explanation of the problem and the solution
```

Dependencies point strictly downward — no module imports one below it in that list — so every
unit is testable in isolation.

---

## Testing

```bash
node --test tests/
```

| Suite | Covers |
|---|---|
| `tokens.test.js` | Token estimation edge cases |
| `rateLimiter.test.js` | Sliding window, dual budgets, `Retry-After`, bounded memory |
| `circuitBreaker.test.js` | Full state machine including trip → recover → trip cycles |
| `models.test.js` | Failure injection, timeouts, error types |
| `metrics.test.js` | Counters, fallback attribution, averages |
| `routes.test.js` | End-to-end over a real socket: status codes, headers, wiring |

Component tests inject a controllable clock (D9), so time-dependent behaviour is verified
deterministically and the whole suite finishes in about two seconds.

---

## Known limitations

Documented honestly, in the order they would be addressed:

1. **Limits are global, not per client** — one heavy caller can degrade service for everyone.
2. **Single-instance only** — two copies would each enforce their own budget, doubling the
   effective limit. Redis would fix this (D7).
3. **Counters reset on restart** — acceptable for rate limiting, not for long-term reporting.
4. **Models are simulated** — connecting real ones means replacing the body of one file (D4).
5. **The reset endpoint is unauthenticated** — fine locally, unacceptable in production (D18).
