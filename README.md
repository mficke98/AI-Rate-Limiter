# AI Rate Limiter & Fallback Proxy

A zero-dependency Node.js proxy for an LLM gateway. Enforces a local sliding-window
request/token budget, trips a circuit breaker when the primary model fails or times out,
and falls back to a lightweight secondary model instead of dropping client requests.

> Status: in active development. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for the
> running decision log and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Requirements
Node.js 20 or later. No dependencies, no install step.

## Run
```bash
node src/server.js
```

## Test
```bash
node --test tests/
```
