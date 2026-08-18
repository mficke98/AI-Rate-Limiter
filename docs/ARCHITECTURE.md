# Architecture

## Problem
An LLM gateway serving client tax queries hits provider rate limits (HTTP 429) under load.
Requests are dropped, and latency spikes on the primary model go unhandled.

## Solution shape
A local reverse proxy that sits in front of two model backends, enforces its own budget
*before* the upstream provider can reject us, and degrades to a lighter model instead of failing.

```
                    POST /api/generate
                            │
                            ▼
                 ┌──────────────────────┐
                 │  1. Rate Limiter     │  sliding window: requests/min + tokens/min
                 └──────────┬───────────┘
              over hard limit│  within budget / over soft limit
                 ┌───────────┴───────────┐
                 ▼                       ▼
            429 + Retry-After   ┌──────────────────────┐
                                │  2. Circuit Breaker  │  CLOSED / OPEN / HALF_OPEN
                                └──────────┬───────────┘
                            CLOSED or HALF_OPEN│      │OPEN, or soft-limited
                                               ▼      ▼
                                     ┌───────────┐  ┌─────────────┐
                                     │  primary  │  │  secondary  │
                                     │   model   │─▶│    model    │  on error/timeout
                                     └─────┬─────┘  └──────┬──────┘
                                           │               │
                                           ▼               ▼
                                        200 OK      200 + X-Fallback-Applied: true
                                                    (503 if secondary also fails)
                            │
                            ▼
                 ┌──────────────────────┐
                 │  3. Metrics recorder │ ◀── GET /api/metrics
                 └──────────────────────┘
```

## Module map

| File | Responsibility | Depends on |
|---|---|---|
| `src/config.js` | Every tunable in one place; overridable for tests | — |
| `src/tokens.js` | Token estimation from prompt/response text | — |
| `src/rateLimiter.js` | Sliding-window counters for requests and tokens | config |
| `src/circuitBreaker.js` | Failure-threshold state machine with cooldown and half-open probe | config |
| `src/models.js` | Simulated `primary-model` / `secondary-model` with injectable failure and latency | config |
| `src/metrics.js` | Counter store read by the metrics route | — |
| `src/routes/generate.js` | Orchestrates limiter → breaker → model → metrics | all of the above |
| `src/routes/metrics.js` | Serialises the metrics snapshot | metrics, breaker, limiter |
| `src/server.js` | HTTP listener, routing, body parsing, error envelope | routes |

Dependencies point strictly downward — no module imports a module below it in this table,
so each unit is testable in isolation with injected config.

## Key design properties
- **Sliding window, not fixed window.** A fixed window allows a burst of 2× the limit across a
  boundary; a sliding window does not. See D8 in the decision log.
- **Fail-fast when OPEN.** An open breaker skips the primary entirely rather than paying its
  timeout, which is the latency benefit that justifies a breaker over plain retries.
- **Pure state machines.** The limiter and breaker take an injected clock, making
  time-dependent behaviour deterministically testable without `sleep`.
