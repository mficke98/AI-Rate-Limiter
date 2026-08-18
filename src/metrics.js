/**
 * In-process metrics store.
 *
 * Backs `GET /api/metrics`, which the brief requires to expose total requests,
 * tokens used, fallback count, and circuit-breaker status.
 *
 * Deliberately a dumb counter bag: it records what happened and computes nothing
 * about *why*. All routing logic lives in the limiter and the breaker, so metrics
 * can never disagree with behaviour by holding a second copy of the rules.
 */

export class MetricsStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.startedAt = now();
    this.reset();
    // `reset` clears counters but must not rewrite the process start time.
    this.startedAt = now();
  }

  reset() {
    /** Every request that reached the proxy, whatever its outcome. */
    this.totalRequests = 0;
    /** Requests served by the primary model. */
    this.primaryRequests = 0;
    /** Requests served by the secondary model for any reason. */
    this.fallbackCount = 0;
    /** Requests shed with a 429 before any model was called. */
    this.rejectedCount = 0;
    /** Requests where both models failed and we returned a 503. */
    this.failedCount = 0;
    /** Primary calls that errored or timed out. */
    this.primaryErrors = 0;
    /** Primary calls that specifically timed out. */
    this.primaryTimeouts = 0;

    this.tokens = { prompt: 0, completion: 0, total: 0 };

    /** Fallbacks broken down by cause, so the metrics explain themselves. */
    this.fallbackReasons = {
      soft_request_limit_exceeded: 0,
      soft_token_limit_exceeded: 0,
      primary_error: 0,
      primary_timeout: 0,
      circuit_open: 0,
    };

    this.latency = { primaryTotalMs: 0, secondaryTotalMs: 0 };
    this.startedAt = this.now();
  }

  /** Called once per request that reaches the proxy. */
  recordRequest() {
    this.totalRequests += 1;
  }

  /** Called when a request is shed at the hard limit. */
  recordRejected() {
    this.rejectedCount += 1;
  }

  /** Called when a request was served by the primary model. */
  recordPrimarySuccess(latencyMs) {
    this.primaryRequests += 1;
    this.latency.primaryTotalMs += latencyMs;
  }

  /**
   * Called when a request was served by the secondary model.
   * @param {string} reason one of the keys of `fallbackReasons`
   */
  recordFallback(reason, latencyMs = 0) {
    this.fallbackCount += 1;
    this.latency.secondaryTotalMs += latencyMs;
    if (reason in this.fallbackReasons) this.fallbackReasons[reason] += 1;
  }

  /** Called when the primary errored or timed out. */
  recordPrimaryFailure({ timedOut = false } = {}) {
    this.primaryErrors += 1;
    if (timedOut) this.primaryTimeouts += 1;
  }

  /** Called when neither model could serve the request. */
  recordTotalFailure() {
    this.failedCount += 1;
  }

  /** Called after every served request, with real token consumption. */
  recordTokens({ prompt = 0, completion = 0, total = 0 }) {
    this.tokens.prompt += prompt;
    this.tokens.completion += completion;
    this.tokens.total += total;
  }

  /**
   * Assemble the response body for `GET /api/metrics`.
   *
   * @param {object} parts
   * @param {object} parts.breaker  snapshot from the circuit breaker
   * @param {object} parts.window   current sliding-window usage
   * @param {object} parts.limits   the configured thresholds
   */
  snapshot({ breaker, window, limits }) {
    const served = this.primaryRequests + this.fallbackCount;
    return {
      uptimeMs: this.now() - this.startedAt,

      requests: {
        total: this.totalRequests,
        servedByPrimary: this.primaryRequests,
        servedByFallback: this.fallbackCount,
        rejected: this.rejectedCount,
        failed: this.failedCount,
      },

      tokens: { ...this.tokens },

      fallback: {
        count: this.fallbackCount,
        rate: served === 0 ? 0 : Number((this.fallbackCount / served).toFixed(4)),
        reasons: { ...this.fallbackReasons },
      },

      circuitBreaker: breaker,

      rateLimit: {
        window: { ...window },
        limits: { ...limits },
      },

      primary: {
        errors: this.primaryErrors,
        timeouts: this.primaryTimeouts,
        avgLatencyMs:
          this.primaryRequests === 0
            ? 0
            : Math.round(this.latency.primaryTotalMs / this.primaryRequests),
      },

      secondary: {
        avgLatencyMs:
          this.fallbackCount === 0
            ? 0
            : Math.round(this.latency.secondaryTotalMs / this.fallbackCount),
      },
    };
  }
}
