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

---

## D7 — State is in-memory and per-process
**Status:** ACCEPTED · **Sprint:** 1

**Context.** The limiter, breaker, and metrics all need mutable state. Options were in-memory, a local file, or Redis.

**Decision.** Plain in-memory data structures, scoped to the single server process.

**Benefits.**
- Zero infrastructure to install or run, consistent with D1.
- Microsecond reads and writes, so the proxy adds negligible latency to the very path it exists to protect.
- The brief explicitly calls for a *local* proxy, which this satisfies exactly.

**Trade-offs.**
- All counters reset on restart — acceptable for rate limiting, less so for long-run metrics.
- Does not survive horizontal scaling: two proxy instances would each enforce their own separate budget, so the effective global limit would be double the configured one.
- **Production path:** swap the limiter's storage for a Redis sorted set keyed by client ID. The interface was designed so this is a single-file change.

---

## D8 — Sliding window rather than fixed window
**Status:** ACCEPTED · **Sprint:** 1

**Context.** The brief asks for a "sliding token limit". The cheaper alternative is a fixed window that resets on a clock boundary.

**Decision.** A trailing window: every request is timestamped, and only events within the last `windowMs` count toward the budget.

**Benefits.**
- Eliminates the boundary burst. Under a fixed window a client can spend the full budget at 11:59:59 and the full budget again at 12:00:00 — twice the intended rate. A regression test asserts this cannot happen.
- Capacity returns smoothly and continuously rather than in a cliff-edge reset, which is a better experience for a client only slightly over budget.
- Yields an accurate `Retry-After` value, computed from when the oldest entry actually expires.

**Trade-offs.**
- Stores one entry per request instead of a single integer counter. At the volumes this proxy targets the cost is irrelevant; at very high throughput it would need a ring buffer or a Redis sorted set.
- Pruning runs on every read, making reads O(expired) rather than O(1). A bounded-memory regression test guards against unbounded growth.

---

## D9 — Injected clock instead of real time in state machines
**Status:** ACCEPTED · **Sprint:** 1

**Context.** Both the limiter and the breaker are time-dependent. Testing them against the real clock requires sleeping, which is slow and flaky.

**Decision.** Both accept a `now()` function, defaulting to `Date.now`. Tests pass a controllable counter.

**Benefits.**
- Window expiry and breaker cooldown are tested deterministically and instantly — the full suite runs in well under a second.
- Scenarios that would take minutes in real time are exercised in microseconds.
- No arbitrary sleep values, so the suite cannot flake on a loaded machine.

**Trade-offs.**
- A small amount of extra ceremony in the constructor signature.
- Tests exercise logical time, not wall-clock behaviour, so the end-to-end smoke script remains necessary to prove the real-time path works.

---

## D10 — Separate `check()` from `record()` in the limiter
**Status:** ACCEPTED · **Sprint:** 1

**Context.** The routing decision must be made *before* a model is called, but the true token cost is only known *after* it responds.

**Decision.** `check(estimatedTokens)` returns a verdict without mutating state; `record(actualTokens)` commits real consumption afterwards.

**Benefits.**
- Recorded usage reflects actual tokens consumed rather than a pre-flight guess, so the metrics endpoint reports the truth.
- A rejected request never pollutes the window, so a throttled client is not punished twice.
- The verdict is a pure function of current state, which makes it trivial to test.

**Trade-offs.**
- Two calls per request instead of one; forgetting the `record` call would silently disable limiting. Mitigated by end-to-end route tests that assert usage actually accumulates.
- A theoretical race window between check and record. Irrelevant in Node's single-threaded event loop, but it would need attention in a multi-threaded port.

---

# Appendix A — Conversation record

Verbatim record of the decision points raised with the stakeholder, the options presented, and the
direction given. Preserved so the reasoning behind each choice is auditable, not just its outcome.

### Exchange 1 — Sprint 0 kickoff

**Claude asked** four questions, each with options plus benefits and trade-offs: runtime stack
(zero-dep Node vs Express vs FastAPI), rate-limit policy (fallback vs 429 vs two-tier), git
workflow (local merge vs direct-to-main vs GitHub PR), and testing depth (unit+smoke vs smoke only
vs manual curl).

**Stakeholder answered:**
1. *Stack* — restated the trade-off ("fastest prototype with limited setup and no NPM install... the trade off is that we have to write more manual code") and chose zero-dependency Node.
2. *Limit policy* — described the intended sequence: circuit breaker trips, primary returns a timeout, fall back to secondary with the header set; if that also fails, catch the error gracefully and report a 429. Asked which option best fits and why.
3. *Git flow* — "Check out from main every time. Each PR needs to belong to its own branch, and then we're going to push to remote, and then we're going to merge that PR into main, and then we're going to update main, and we're going to repeat the process iteratively."
4. *Testing* — required "robust and comprehensive unit testing" as "proof of evidence that what we are doing works and the code integrity is there."

**Claude responded** with one correction and one gap:
- *Correction:* `429 Too Many Requests` belongs to the rate limiter, not to the both-backends-failed case. Using it there instructs the client to slow down when the real fault is backend unavailability, and standard retry libraries would then apply the wrong strategy. `503 Service Unavailable` is the correct signal. Recorded as D2.
- *Gap:* the stakeholder asked for front-end unit tests, but the brief specifies two JSON endpoints and no UI — so no front end existed to test. Flagged rather than silently assumed either way.
- *Minor note:* in-memory state follows from this being a single-process prototype, not from the zero-dependency choice. Recorded as D7.

**Stakeholder confirmed** the two-tier policy with a 503 last resort, and deferred the front-end
decision: "Ask me when we get to that point in the project if we should have a front end depending
on how much time we have left... presumably in React." Recorded as D6.

### Exchange 2 — Mid-sprint direction

**Stakeholder instructed:** keep documentation updated in parallel with the code; catalogue every
decision with its rationale, benefits, trade-offs, and the dialogue on both sides; and write the
final documentation so a non-technical reader seeing it for the first time can understand it.

**Claude's response:** added this appendix so the dialogue is preserved rather than only the
outcomes, and committed to writing `REPORT.md` in plain language for a non-technical reader.
