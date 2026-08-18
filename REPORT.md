# Project Report

*Written to be read by anyone, technical or not. No prior knowledge assumed.*

---

## 1. The problem, in plain terms

Deloitte runs an **LLM Gateway** — a service that takes tax questions from client-facing
applications and sends them to a large AI language model, which writes the answer.

That AI model is a shared, paid resource with a cap on how much it will handle. When traffic is
heavy, the model provider starts refusing requests, returning an error code called **429 — "Too
Many Requests."**

Without protection, three bad things happen:

1. **Client questions get dropped.** A refusal from the provider becomes an error on someone's
   screen. They asked a legitimate question and got nothing.
2. **Slow is as bad as broken.** When the model is struggling it does not always fail cleanly —
   sometimes it just takes forever to answer. Requests pile up waiting on a service that is not
   going to respond in time, and the backlog makes the overload worse.
3. **Nobody can see it happening.** Without measurement, the first sign of trouble is a client
   complaint.

The core insight is that **there is a middle option between a perfect answer and no answer at
all.** A shorter answer from a smaller, cheaper model is far better than an error message. This
project builds the piece that makes that middle option possible.

---

## 2. What we built

A **proxy** — a small piece of software that sits between the client application and the AI models
and makes a routing decision about every single request before it goes anywhere.

```
   Client app                                            AI models
       │                                                     │
       │      ┌───────────────────────────────────┐          │
       │      │         THE PROXY                 │          │
       └─────▶│                                   │          │
              │  1. Am I over budget?             │──────────┼──▶ primary-model
              │  2. Is the main model healthy?    │          │    (smart, slower,
              │  3. Record what happened          │──────────┼──▶  expensive)
              │                                   │          │
              └───────────────────────────────────┘          │    secondary-model
                            │                                │    (lighter, faster,
                            ▼                                │     cheaper)
                     Live metrics dashboard
```

It has three moving parts.

### Part 1 — The budget keeper (rate limiter)

Counts how many requests and how many words have gone through in the last 60 seconds, and
enforces two thresholds:

- **Soft limit (5 requests/minute).** Over this, the request is quietly handed to the *lighter*
  model instead of the main one. The client still gets an answer.
- **Hard limit (15 requests/minute).** Over this, the proxy refuses the request and tells the
  caller exactly how many seconds to wait. This is the safety valve that protects the gateway
  from collapse under genuine flooding.

The key property is that the 60-second window **slides continuously** rather than resetting on
the minute. This matters more than it sounds — see §4.

### Part 2 — The safety switch (circuit breaker)

Named after the electrical device, and it works the same way. It watches the main model. After
**three failures in a row**, it "trips" and stops sending traffic there entirely, routing
everything to the backup model instead.

This is the counter-intuitive but critical piece: **when a service is broken, the fastest thing
you can do is stop calling it.** Every request sent to a hung model waits for the full timeout
before giving up. Multiply that by heavy traffic and a slow service becomes a total outage. By
refusing to even try, the proxy responds instantly instead.

After a cooldown, it lets **one** request through as a test. If that works, normal service
resumes automatically. Nobody has to notice, log in, or restart anything.

### Part 3 — The dashboard (metrics)

A live readout of exactly what the proxy is doing: total requests, words consumed, how many
requests were downgraded to the backup model **and why**, and the current state of the safety
switch.

---

## 3. How this solves the problem

| The original problem | How the proxy solves it |
|---|---|
| Client questions get dropped under load | They are answered by the lighter model instead. The client always gets *something*. |
| The gateway is overwhelmed and collapses | The hard limit sheds excess traffic *before* it reaches the gateway, with clear instructions on when to retry. |
| A slow model creates a growing backlog | The safety switch stops calling a failing model entirely, so no request waits on a timeout that was never going to succeed. |
| Recovery requires manual intervention | The switch tests the model automatically and restores normal service on its own. |
| Nobody can see what is happening | Every decision is counted and exposed live, broken down by cause. |

**The result:** under conditions that would previously have produced errors, clients now receive
answers. Sometimes shorter answers — and the response is honestly labelled with a header,
`X-Fallback-Applied: true`, so the calling application always knows which model answered and can
present it accordingly.

---

## 4. Every major technical choice, and why

### Choice 1 — Build it with no external software libraries
**What:** Node.js and its built-in features only. Nothing downloaded.
**Why:** Anyone can run this with one command and no installation step. Nothing can break because
a download failed, and there is no third-party code to audit or keep patched.
**The cost:** We hand-wrote about 40 lines of plumbing that a standard library would have provided.
A worthwhile trade for a prototype that must be instantly runnable; a long-lived production
service would likely take the library.

### Choice 2 — Downgrade first, refuse only as a last resort
**What:** Two thresholds instead of one. Over the first, you get the lighter model. Over the
second, you are refused.
**Why:** The whole business point is that clients keep getting answers. A single threshold forces
a choice between never refusing anyone (and letting the gateway collapse) or refusing people who
could easily have been served. Two thresholds get both: graceful degradation for normal overload,
a real safety valve for genuine flooding.
**The cost:** More logic to build, explain, and test than a single cut-off.

### Choice 3 — A continuously sliding 60-second window
**What:** We count the last 60 seconds from *right now*, rather than resetting the count each
minute on the clock.
**Why:** A resetting counter has an exploitable flaw. With a 5-per-minute limit, a client can send
5 requests at 11:59:59 and 5 more at 12:00:00 — **10 requests in one second**, double the intended
rate, without technically breaking the rule. A sliding window makes this impossible. There is an
automated test whose only job is to prove this cannot happen.
**The cost:** Slightly more memory, since we remember each request's timestamp instead of keeping
one running number. Irrelevant at this scale.

### Choice 4 — Trip on three failures *in a row*
**What:** The safety switch counts consecutive failures. Any single success resets the count to
zero.
**Why:** Simple, predictable, and easy to demonstrate. The obvious alternative — tripping on a
failure *percentage* — misbehaves badly at low traffic, where one failure out of two requests
looks like a catastrophic 50% failure rate and trips the switch over essentially nothing.
**The cost:** A model that fails every other request would never trip the switch, despite being
badly degraded. A production system handling far more traffic would use a percentage with a
minimum sample size.

### Choice 5 — A slow model and a broken model are treated the same
**What:** A timeout and an error both count as one failure.
**Why:** From the client's point of view they are identical: no usable answer arrived. Routing
should respond to the symptom, not the diagnosis. The two are still *reported* separately in the
metrics, because when you are investigating a problem the difference matters a great deal.
**The cost:** We cannot apply a different, gentler policy to slowness than to hard errors.

### Choice 6 — "Too many requests" and "everything is down" are different answers
**What:** Being over the limit returns `429`. Both models failing returns `503`.
**Why:** These codes are instructions to the calling application, not just labels. `429` means
"you are going too fast, slow down" — correct when the client is over budget. If we used it when
both models were down, we would be blaming the client for our own outage, and their automatic
retry logic would then back off for exactly the wrong reason. `503` means "we cannot serve anyone
right now," which is the truth.
**Note:** this was raised as a correction during the design discussion and is recorded in the
decision log as D2.

### Choice 7 — Reading the dashboard cannot change the system's behaviour
**What:** The metrics endpoint is strictly read-only.
**Why:** This prevents a genuinely nasty class of bug. The safety switch recovers by letting one
test request through after its cooldown. If simply *checking* the switch's state consumed that
opportunity, a monitoring dashboard refreshing every second would silently prevent the system from
ever recovering — and the harder you watched it, the more broken it would be. There is a test
whose entire purpose is to prove this cannot happen.
**The cost:** For a few seconds the dashboard may show "tripped" for a switch that is technically
ready to test again. It also displays a countdown, so this is visible rather than confusing.

### Choice 8 — The AI models are simulated
**What:** Two stand-in models with adjustable speed and a switch to make them fail on command.
**Why:** You cannot test a safety switch on a service that refuses to break. Simulated models let
every failure scenario be demonstrated on demand and tested reliably, with no API keys, no cost,
and no internet connection.
**The cost:** This is deliberately a prototype. Connecting real models means replacing the contents
of one file; everything around it stays as it is.

### Choice 9 — Nothing is stored on disk
**What:** All counters live in the running program's memory.
**Why:** No database to install, configure, or run. The brief asks for a *local* proxy, and this is
exactly that.
**The cost:** Counters reset if the service restarts, and running two copies would mean each
enforces its own separate budget — so the real limit would be double what was configured. The fix
for a production deployment is a shared store such as Redis, and the code was structured so this
is a change to one file.

---

## 5. How we know it works

**102 automated tests, all passing.** They fall into two groups:

- **Component tests** check each part in isolation. These use a *simulated clock*, which lets us
  test "what happens after 60 seconds" instantly and reliably, instead of actually waiting.
- **End-to-end tests** start a real server and send real network requests to it, confirming that
  the labels and instructions on each response are correct as they actually reach the client.

Several tests exist specifically to catch mistakes that would otherwise be invisible:

- Proof that the boundary loophole in Choice 3 cannot be exploited.
- Proof that watching the dashboard cannot prevent recovery (Choice 7).
- Proof that a malformed request cannot consume a legitimate user's budget.
- Proof that a refused request is not counted against the client, so retrying while throttled
  cannot dig them into a hole they can never climb out of.

There is also a demonstration script — `node scripts/demo.js` — which walks through all seven
scenarios in sequence and prints what happened at each step.

**One real bug was found and fixed during development**, and it is documented rather than quietly
patched. On Windows, the server silently failed to start when the project folder name contained
spaces — and it reported success while doing so, which is the most dangerous kind of failure. It
was caught within seconds by testing against a live server rather than trusting the code to be
right. Recorded as D23.

---

## 6. What we would do next

Honest limitations, in the order we would address them:

1. **Limits are global, not per client.** Every caller shares one budget today, so one heavy user
   can degrade service for everyone. The fix is to key the limiter by client identity.
2. **It runs as a single copy.** Two instances would each enforce their own budget. A shared store
   such as Redis solves this, and the code was structured to make that a single-file change.
3. **Counters reset on restart.** Fine for rate limiting, not for long-term reporting. Metrics
   would be exported to a monitoring system.
4. **The models are simulated.** Connecting real ones means replacing the contents of one file.
5. **The reset endpoint is unprotected.** Convenient for demonstrations, unacceptable in
   production, where it would be secured or removed.

---

## 7. Where to find things

| Document | What it contains |
|---|---|
| [`README.md`](README.md) | How to run it, and the full API reference |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every decision (D1–D23), with benefits and trade-offs, plus a record of the discussions behind them |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Technical design and how the modules fit together |
| `scripts/demo.js` | Runnable demonstration of all seven scenarios |

The project was built in numbered sprints, each one a separate pull request on GitHub, so the
sequence in which it was built can be read directly from the repository history.
