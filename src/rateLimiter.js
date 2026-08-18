/**
 * Sliding-window rate limiter tracking both request count and token usage.
 *
 * Why sliding and not fixed (decision D8): a fixed window resets on a clock
 * boundary, so a client can send the full budget at 11:59:59 and the full budget
 * again at 12:00:00 — twice the intended rate in one second. A sliding window
 * counts only events inside the trailing `windowMs`, so the limit always holds.
 *
 * Implementation: an array of timestamped entries, pruned on every read. For a
 * local proxy at single-digit requests per minute this is trivially cheap; a
 * high-throughput deployment would swap it for a ring buffer or Redis sorted set.
 */

export const Decision = Object.freeze({
  /** Within budget — use the primary model. */
  ALLOW: 'ALLOW',
  /** Over the soft limit — degrade to the secondary model. */
  DEGRADE: 'DEGRADE',
  /** Over the hard limit — shed the request with a 429. */
  REJECT: 'REJECT',
});

export class SlidingWindowRateLimiter {
  /**
   * @param {object} options
   * @param {object} options.config - the `rateLimit` config section
   * @param {() => number} [options.now] - injectable clock, for deterministic tests
   */
  constructor({ config, now = Date.now }) {
    this.config = config;
    this.now = now;
    /** @type {Array<{at: number, tokens: number}>} */
    this.entries = [];
  }

  /** Drop entries that have aged out of the trailing window. */
  #prune() {
    const cutoff = this.now() - this.config.windowMs;
    // Entries are appended in time order, so the expired ones are a prefix.
    let firstLive = 0;
    while (firstLive < this.entries.length && this.entries[firstLive].at <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) this.entries.splice(0, firstLive);
  }

  /** Current usage inside the window. */
  usage() {
    this.#prune();
    let tokens = 0;
    for (const entry of this.entries) tokens += entry.tokens;
    return { requests: this.entries.length, tokens };
  }

  /**
   * Decide how to handle an incoming request *without* recording it.
   * Separated from `record` because the true token cost is only known after the
   * model responds, while the routing decision must be made before it is called.
   *
   * @param {number} [estimatedTokens] tokens the request is expected to consume
   * @returns {{decision: string, reason: string|null, usage: object, retryAfterSeconds: number|null}}
   */
  check(estimatedTokens = 0) {
    const { requests, tokens } = this.usage();
    const projectedTokens = tokens + estimatedTokens;
    const c = this.config;

    if (requests >= c.hardMaxRequests) {
      return this.#verdict(Decision.REJECT, 'hard_request_limit_exceeded', requests, tokens);
    }
    if (projectedTokens >= c.hardMaxTokens) {
      return this.#verdict(Decision.REJECT, 'hard_token_limit_exceeded', requests, tokens);
    }
    if (requests >= c.softMaxRequests) {
      return this.#verdict(Decision.DEGRADE, 'soft_request_limit_exceeded', requests, tokens);
    }
    if (projectedTokens >= c.softMaxTokens) {
      return this.#verdict(Decision.DEGRADE, 'soft_token_limit_exceeded', requests, tokens);
    }
    return this.#verdict(Decision.ALLOW, null, requests, tokens);
  }

  #verdict(decision, reason, requests, tokens) {
    return {
      decision,
      reason,
      usage: { requests, tokens },
      retryAfterSeconds:
        decision === Decision.REJECT ? this.secondsUntilCapacity() : null,
    };
  }

  /**
   * Seconds until the oldest in-window entry expires, i.e. the soonest moment
   * capacity could free up. Used for the `Retry-After` header on a 429.
   */
  secondsUntilCapacity() {
    this.#prune();
    if (this.entries.length === 0) return 0;
    const oldest = this.entries[0].at;
    const freesAt = oldest + this.config.windowMs;
    return Math.max(1, Math.ceil((freesAt - this.now()) / 1000));
  }

  /**
   * Record actual consumption. Called after the model responds so the recorded
   * token count is the real one rather than the pre-flight estimate.
   *
   * @param {number} tokens
   */
  record(tokens = 0) {
    this.entries.push({ at: this.now(), tokens });
    this.#prune();
  }

  /** Reset all state. Used by tests and by the metrics reset path. */
  reset() {
    this.entries = [];
  }
}
