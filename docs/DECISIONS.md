# Decision Log

Running record of every architectural decision, its rationale, benefits, and trade-offs.
Newest entries are appended at the bottom. Format is lightweight ADR.

**Status legend:** `ACCEPTED` = in force · `SUPERSEDED` = replaced by a later entry · `DEFERRED` = deliberately postponed.

---

## D1 — Runtime: Node 20 with zero third-party dependencies
**Status:** ACCEPTED · **Sprint:** 0

**Context.** The proxy must be runnable locally by a reviewer inside a 30-minute build window. Candidates were zero-dependency Node (`node:http`), Node + Express, and Python + FastAPI.

**Decision.** Node 20 using only the standard library (`node:http`, `node:test`).

**Benefits.**
- No `npm install` step — nothing to fail on a network hiccup, and a reviewer runs `node src/server.js` with zero setup.
- No dependency tree, therefore no transitive supply-chain surface and no lockfile churn.
- `node:test` and `node:assert` ship with the runtime, so comprehensive testing costs no dependencies either.
- Fastest path from empty directory to a running, pushable service.

**Trade-offs.**
- We hand-write routing, JSON body parsing, and response helpers — roughly 40 lines Express would have given us free.
- No middleware ecosystem to lean on if scope grows (auth, compression, CORS would all be manual).
- The framework-free code is less idiomatic to a reviewer who expects Express conventions.

**Note.** In-memory state is a consequence of this being a single-process prototype, *not* of the zero-dependency choice — Express would be equally in-memory. See D7.

---

## D2 — Request-outcome policy: two-tier limiting with a 503 last resort
**Status:** ACCEPTED · **Sprint:** 0

**Context.** The brief says both "enforce a sliding token limit" *and* "gracefully falls back … when limits are reached", which pull in opposite directions: strict limiting rejects, graceful degradation serves. A single policy cannot honour both.

**Decision.** Four distinct outcomes:

| Condition | Backend | Status | `X-Fallback-Applied` |
|---|---|---|---|
| Within budget, primary healthy | `primary-model` | 200 | `false` |
| Over **soft** limit (5 req/min) | `secondary-model` | 200 | `true` |
| Over **hard** limit (15 req/min) | none — shed | 429 + `Retry-After` | absent |
| Primary errors/times out, or breaker OPEN | `secondary-model` | 200 | `true` |
| Primary *and* secondary both fail | none | 503 | `true` |

**Benefits.**
- Honours the business context: a tax client over the soft limit receives a degraded answer rather than a dropped request.
- Still genuinely sheds load at the hard limit, so requirement 1 ("enforce a budget") is demonstrably satisfied, not just claimed.
- Every HTTP status carries its true meaning, so off-the-shelf client retry logic behaves correctly.
- All four outcomes are reachable in a demo, making the behaviour observable rather than theoretical.

**Trade-offs.**
- Two thresholds and five branches to document, implement, and test — the most code of the options considered.
- A caller cannot tell "throttled to secondary" from "primary failed" by status code alone; we mitigate this with a `reason` field in the response body.

**Rejected alternative.** Returning `429` when both backends fail (the literal initial phrasing). Rejected because `429 Too Many Requests` instructs the client to back off, which is actively misleading when the real fault is total backend unavailability; standard retry libraries would apply the wrong strategy. `503 Service Unavailable` is the correct signal.

---

## D3 — Git workflow: branch per micro-sprint, merged to main via GitHub PR
**Status:** ACCEPTED · **Sprint:** 0

**Context.** Delivery must be iterative and visibly so, merging fast and often.

**Decision.** Each micro-sprint branches from an up-to-date `main` as `sprint/N-name`, is pushed to origin, opened as a PR, merged into `main`, and `main` is then pulled locally before the next branch is cut. Sprint 0 alone commits directly to `main` to create the base branch a PR requires.

**Benefits.**
- Produces real review artifacts on GitHub — each sprint is an inspectable, independently reviewable unit.
- Merge commits make the iterative cadence legible in the history graph.
- Closest match to a real team workflow, which is itself part of what the exercise assesses.

**Trade-offs.**
- A network round-trip to GitHub per sprint, which is the slowest of the workflows considered.
- Requires the `gh` CLI to be authenticated (confirmed available).

---

## D4 — Simulated model backends with injectable failure
**Status:** ACCEPTED · **Sprint:** 0

**Context.** The brief specifies a *simulated* primary model. The circuit breaker cannot be demonstrated or tested unless failures can be produced on demand.

**Decision.** `src/models.js` exposes `primary-model` and `secondary-model` as async functions with configurable latency and a controllable failure mode, driven by config and overridable per-request via an explicit test-only field.

**Benefits.**
- Deterministic tests — no reliance on random chance to observe the breaker opening.
- A live demo can force the fallback path on cue rather than waiting for it.
- No API keys, cost, or network dependency in the prototype.

**Trade-offs.**
- A test-only control surface exists on a production-shaped endpoint; it must be clearly documented as simulation-only and would need removal before any real deployment.
- Simulated latency distributions will not match a real model's tail behaviour.

---

## D5 — Testing: `node:test` unit suite plus an end-to-end smoke script
**Status:** ACCEPTED · **Sprint:** 0

**Context.** Evidence of code integrity was required, covering the stateful logic that is hardest to verify by hand.

**Decision.** Built-in `node --test` unit coverage for the sliding-window limiter, circuit-breaker state machine, token estimator, and both routes end-to-end, plus a scripted smoke run against a live server.

**Benefits.**
- Sliding-window expiry and half-open recovery are timing-dependent and effectively unverifiable manually — tests are the only credible proof.
- Zero additional dependencies, consistent with D1.
- The smoke script doubles as a one-command demo.

**Trade-offs.**
- Consumes roughly one sprint of the budget that could have gone to features.
- Timing-sensitive tests need short, tunable windows to stay fast and non-flaky, so tests run against injected config rather than production defaults.

---

## D6 — Front end: deferred
**Status:** DEFERRED · **Sprint:** 0

**Context.** The brief specifies two JSON endpoints and no UI. A live dashboard would make the breaker state visible during a demo but is additive scope.

**Decision.** Postponed. Revisit once the backend is complete and green, and build only if time remains.

**Benefits of deferring.** Guarantees the graded requirements are finished first; avoids spending the timebox on unscored scope.

**Trade-offs.** If time runs out the demo is curl plus the smoke script, and the requested front-end unit tests have no subject.

**If built.** React delivered via CDN in a single static file, preserving the zero-install, zero-build property of D1 rather than introducing a bundler.
