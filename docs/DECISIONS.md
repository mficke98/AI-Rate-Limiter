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

---

## D11 — Three-state circuit breaker (CLOSED / OPEN / HALF_OPEN)
**Status:** ACCEPTED · **Sprint:** 2

**Context.** The brief names two states, `CLOSED` and `OPEN`. A two-state breaker has no defined way to recover: something must eventually retry the primary to discover it is healthy again.

**Decision.** Implement the standard three-state breaker. `HALF_OPEN` is an internal probing state entered automatically once the cooldown elapses.

**Benefits.**
- Recovery is automatic and requires no operator intervention or restart.
- Only a small number of probe requests are exposed to a still-unhealthy primary, instead of the full traffic flow being dumped back onto it the instant the cooldown ends.
- Requiring `successThreshold` consecutive successes prevents a single lucky response from prematurely declaring recovery and causing the breaker to flap.
- Still satisfies the brief exactly: `/api/metrics` reports `CLOSED` and `OPEN` as required, with `HALF_OPEN` as extra fidelity.

**Trade-offs.**
- A third state to reason about, document, and test.
- A small number of probe requests will be slower than a fallback would have been, since they pay the primary's timeout before failing over. This is the price of ever recovering at all.

---

## D12 — Count consecutive failures, not a failure ratio
**Status:** ACCEPTED · **Sprint:** 2

**Context.** Breakers commonly trip on either N consecutive failures or a failure percentage over a rolling window.

**Decision.** Trip on `failureThreshold` consecutive failures; any success resets the counter to zero.

**Benefits.**
- Trivial to reason about and to demonstrate: three failures in a row trips it, full stop.
- Immune to a low-traffic distortion that ratio-based breakers suffer, where one failure out of two requests reads as a catastrophic 50% error rate.
- Intermittent, unrelated failures cannot accumulate into a trip — there is an explicit test asserting this.

**Trade-offs.**
- A primary that fails 50% of the time in an alternating pattern would never trip the breaker, despite being badly degraded.
- **Production path:** a rolling error-rate window with a minimum-sample floor. Overkill for a prototype whose demo needs deterministic, explainable behaviour.

---

## D13 — Timeouts and errors are treated identically by the breaker
**Status:** ACCEPTED · **Sprint:** 2

**Context.** The brief distinguishes "returns an error" from "latency spikes". They could be counted separately.

**Decision.** Both increment the same failure counter. `ModelTimeoutError` and `ModelFailureError` are distinct classes for *reporting*, but the breaker treats them as one thing.

**Benefits.**
- From the client's perspective a hung model and a broken model are the same problem: no usable answer arrives. Routing should respond to the symptom, not the cause.
- One counter means one threshold to tune, rather than two interacting ones.
- The metrics endpoint still reports timeouts separately, so the distinction is preserved where it actually matters — diagnosis.

**Trade-offs.**
- Cannot apply a different tripping policy to slowness than to hard errors, which a mature gateway might want.

---

## D14 — `snapshot()` is side-effect free; `allowsPrimary()` is not
**Status:** ACCEPTED · **Sprint:** 2

**Context.** An OPEN breaker past its cooldown must move to HALF_OPEN. Something has to trigger that, and cooldown expiry is driven by time rather than by any event.

**Decision.** The transition happens inside `allowsPrimary()`, which is only called on the request path. `snapshot()`, which backs the metrics endpoint, never mutates state.

**Benefits.**
- Polling `GET /api/metrics` can never alter proxy behaviour. A monitoring dashboard refreshing every second would otherwise silently consume the probe opportunity — a genuinely nasty class of bug.
- Metrics report what the breaker will actually do for the next real request.
- Avoids a background timer, keeping the whole system driven purely by request flow.

**Trade-offs.**
- Metrics may briefly show `OPEN` for a breaker whose cooldown has technically expired, until a real request arrives to probe it. `cooldownRemainingMs: 0` makes this visible, and a covering test documents the behaviour as intentional.

---

## D15 — Metrics store holds no routing logic
**Status:** ACCEPTED · **Sprint:** 2

**Context.** The metrics endpoint reports fallback counts and breaker state, which it could plausibly derive itself.

**Decision.** `MetricsStore` is a dumb counter bag. It records what the route tells it and computes only simple aggregates (rates, averages).

**Benefits.**
- Metrics can never disagree with behaviour, because they hold no second copy of the routing rules to drift out of sync.
- Every counter is trivially unit-testable in isolation.
- Adding a new metric never risks changing how requests are routed.

**Trade-offs.**
- The route must remember to record each outcome; a missing call means a silently wrong metric. Mitigated by end-to-end route tests that assert counters actually move.

---

## D16 — Fallbacks are counted by cause
**Status:** ACCEPTED · **Sprint:** 2

**Context.** The brief asks only for a fallback count. Under D2 a fallback can occur for five different reasons.

**Decision.** Report the total *and* a per-cause breakdown: soft request limit, soft token limit, primary error, primary timeout, circuit open.

**Benefits.**
- A bare count is ambiguous — "40 fallbacks" could mean the primary is broken or simply that traffic is over budget, which demand completely different responses.
- Makes the metrics endpoint self-explaining during a demo: the numbers narrate what happened.
- Costs one extra object of integer counters.

**Trade-offs.**
- A slightly larger response payload and one more thing to keep in sync as causes are added.

---

## D17 — A composition root builds all collaborators
**Status:** ACCEPTED · **Sprint:** 3

**Context.** The limiter, breaker, models, and metrics store all need to be constructed and wired together. They could each construct their own dependencies, or a single factory could do it.

**Decision.** `src/app.js` exposes `createApp(overrides)`, which builds one fully wired set of collaborators. Nothing below it constructs its own dependencies.

**Benefits.**
- A test can spin up a complete, isolated proxy with millisecond windows and a hair-trigger breaker without touching production defaults — this is what makes the 102-test suite run in about two seconds.
- Tests are fully isolated from one another: each gets its own limiter and breaker, so no test can leak state into the next.
- Swapping the simulated models for real HTTP clients is a change to one file.

**Trade-offs.**
- One more layer of indirection to follow when reading the code.
- Dependencies are passed as a single `deps` object rather than named parameters, which is slightly looser typing than ideal in plain JavaScript.

---

## D18 — Two endpoints beyond the brief: health and metrics reset
**Status:** ACCEPTED · **Sprint:** 3

**Context.** The brief specifies `POST /api/generate` and `GET /api/metrics` only.

**Decision.** Add `GET /api/health` and `POST /api/metrics/reset`.

**Benefits.**
- A demo that cannot be reset is a demo you get exactly one shot at. Once the hard limit is hit, every subsequent request returns 429 for a full minute — reset makes the system demonstrable repeatedly, and the demo script depends on it.
- `/api/health` is the conventional liveness probe any real deployment target expects, and it costs three lines.
- Reset is a separate route from the metrics read, so polling can never clear the counters by accident.

**Trade-offs.**
- Reset is unauthenticated. Acceptable for a local prototype; in production it would need to be an admin-scoped route or removed entirely.
- Two endpoints beyond the specification, which is scope the brief did not ask for.

---

## D19 — Validation happens before any counter moves
**Status:** ACCEPTED · **Sprint:** 3

**Context.** A request with a missing or malformed prompt could be counted against the budget or ignored by it.

**Decision.** Requests failing validation return 400 before `metrics.recordRequest()` or any limiter interaction.

**Benefits.**
- A client's own malformed request cannot exhaust the budget that its well-formed requests depend on.
- Metrics report real traffic rather than a mix of traffic and client bugs.
- A covering test asserts that five invalid requests leave the window completely untouched.

**Trade-offs.**
- A client spamming malformed requests is not rate-limited by this proxy at all. Mitigated in part by the 1 MB body cap; in production this belongs to an edge WAF rather than an application-level breaker.

---

## D20 — A rejected request is not recorded against the window
**Status:** ACCEPTED · **Sprint:** 3

**Context.** When a request is shed with a 429, it could either be recorded (counting the attempt) or ignored.

**Decision.** Shed requests never enter the sliding window. Only requests that actually reached a model are recorded.

**Benefits.**
- A client that retries aggressively while throttled cannot dig itself deeper into a hole it can never climb out of.
- `Retry-After` stays accurate: it is computed from real served requests, so waiting the advertised time genuinely frees capacity.
- Metrics separate `rejected` from `servedByFallback`, so throttling and degradation never look like the same event.

**Trade-offs.**
- The proxy does no accounting for abusive traffic — a client hammering it while throttled costs CPU that no counter reflects. Visible via `requests.rejected`, but not acted upon.

---

## D21 — The HTTP layer holds no business logic
**Status:** ACCEPTED · **Sprint:** 3

**Context.** With no framework (D1), routing and parsing are hand-written and could easily accumulate logic.

**Decision.** `src/server.js` only parses, routes, serialises, and catches transport errors. Route handlers are pure functions of `(deps, body)` returning `{status, headers, body}`.

**Benefits.**
- Handlers can be tested as plain function calls *and* over a real socket, and the tests exercise the same code path either way.
- Replacing the transport (Express, Fastify, a serverless handler) touches exactly one file.
- A top-level catch guarantees a handler bug returns a 500 rather than taking the process down — which matters especially in a component whose entire purpose is keeping traffic flowing when things break.

**Trade-offs.**
- Handlers build a response object instead of writing to the socket, so streaming responses would need a different shape. Not a constraint for JSON, but it would matter if the proxy ever streamed tokens.

---

## D22 — End-to-end tests run against a real socket
**Status:** ACCEPTED · **Sprint:** 3

**Context.** Route tests could call the handler functions directly, which is faster, or go over real HTTP.

**Decision.** `tests/routes.test.js` starts a real server on an ephemeral port (`listen(0)`) and uses `fetch`.

**Benefits.**
- Actually verifies the headers the brief grades on. `X-Fallback-Applied` and `Retry-After` are only real once they have survived serialisation onto a socket.
- Catches wiring bugs that direct handler calls cannot see: JSON parsing, content types, method routing.
- Port 0 means the suite never collides with a developer's already-running server.

**Trade-offs.**
- Roughly two seconds of suite runtime rather than milliseconds.
- Two tests use a real `setTimeout` to wait out the breaker cooldown, so they are the only wall-clock-dependent tests in the suite. The cooldown is set to 200 ms in test config to keep this cheap.

---

## D23 — Windows entry-point guard uses `pathToFileURL`
**Status:** ACCEPTED · **Sprint:** 3 · *(bug found and fixed during the sprint)*

**Context.** `server.js` must start a listener when run directly but not when imported by a test. The idiomatic check compares `import.meta.url` against `process.argv[1]`.

**Bug found.** The initial string comparison failed silently on Windows: this project's path contains spaces, which `import.meta.url` percent-encodes (`%20`) while `process.argv[1]` does not. `node src/server.js` started no listener and exited without error — caught immediately because the first live curl returned nothing.

**Decision.** Compare `import.meta.url` against `pathToFileURL(process.argv[1]).href`, which normalises both sides.

**Benefits.**
- Correct on Windows, macOS, and Linux regardless of spaces or path separators.
- Fails loudly rather than silently if it ever breaks again, because the server simply will not start.

**Trade-offs.**
- One extra import. Recorded here because the failure mode — a silent no-op with a zero exit code — is worth documenting for anyone who hits it again.

---

## D24 — Front end dropped; documentation prioritised
**Status:** ACCEPTED · **Sprint:** 4 · *(supersedes the deferral in D6)*

**Context.** D6 deferred the front-end decision until the backend was complete. At that point the stakeholder chose "docs + React dashboard", then flagged that eight minutes remained and asked for an honest assessment.

**Decision.** Drop the dashboard. Finish `README.md` and `REPORT.md` and merge them.

**Claude's assessment, given verbatim:** building the dashboard, testing it, and landing two pull requests in the remaining time would realistically mean shipping the UI thin or unmerged, while risking the two deliverables the stakeholder had named explicitly.

**Benefits.**
- Everything explicitly requested is delivered and merged rather than left partially done.
- The decision log and plain-language report are the highest-value artifacts for a reviewer, and both are complete.
- Avoids leaving untested UI code in the repository, which would weaken rather than strengthen the integrity claim.

**Trade-offs.**
- No visual demonstration; the demo remains `scripts/demo.js` in the terminal.
- The requested front-end unit tests have no subject, so test coverage is backend-only.
- **If resumed:** a single-file React dashboard delivered via CDN, polling `/api/metrics`, preserving the zero-install property of D1.
