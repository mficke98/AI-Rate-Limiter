/**
 * Circuit breaker for the primary model.
 *
 * The problem it solves: when an upstream model is unhealthy, naively retrying
 * it means every single request pays the full timeout before failing over. Under
 * load that turns a degraded backend into a total outage, because requests pile
 * up waiting on a service that is not going to answer.
 *
 * The breaker watches for consecutive failures. Once it has seen enough of them
 * it "opens" and stops calling the primary at all, routing straight to the
 * fallback. After a cooldown it lets a single probe request through to check
 * whether the primary has recovered.
 *
 *      CLOSED  --failureThreshold consecutive failures-->  OPEN
 *        ^                                                   |
 *        |                                          cooldownMs elapsed
 *        |                                                   v
 *        +--- successThreshold consecutive successes --  HALF_OPEN
 *                                                            |
 *                          any failure ----------------------+--> OPEN
 *
 * See decisions D11 (three-state design) and D12 (consecutive-failure counting).
 */

export const BreakerState = Object.freeze({
  /** Healthy. Requests go to the primary model. */
  CLOSED: 'CLOSED',
  /** Tripped. The primary is skipped entirely; requests go straight to fallback. */
  OPEN: 'OPEN',
  /** Probing. A limited number of trial requests are allowed through. */
  HALF_OPEN: 'HALF_OPEN',
});

export class CircuitBreaker {
  /**
   * @param {object} options
   * @param {object} options.config - the `circuitBreaker` config section
   * @param {() => number} [options.now] - injectable clock (decision D9)
   */
  constructor({ config, now = Date.now }) {
    this.config = config;
    this.now = now;
    this.state = BreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    /** Timestamp at which an OPEN breaker becomes eligible to probe. */
    this.openedAt = null;
    /** Lifetime counters, surfaced via the metrics endpoint. */
    this.totalTrips = 0;
    this.lastStateChangeAt = now();
    this.lastError = null;
  }

  /**
   * Whether the primary model may be attempted right now.
   *
   * Has a side effect by design: an OPEN breaker whose cooldown has elapsed
   * transitions itself to HALF_OPEN here. Cooldown expiry is driven by the
   * passage of time, and this is the only moment the breaker is consulted, so
   * this is where that transition has to happen.
   *
   * @returns {boolean}
   */
  allowsPrimary() {
    if (this.state === BreakerState.OPEN && this.#cooldownElapsed()) {
      this.#transitionTo(BreakerState.HALF_OPEN);
    }
    return this.state !== BreakerState.OPEN;
  }

  #cooldownElapsed() {
    if (this.openedAt === null) return false;
    return this.now() - this.openedAt >= this.config.cooldownMs;
  }

  /** Record a successful primary call. */
  recordSuccess() {
    this.consecutiveFailures = 0;

    if (this.state === BreakerState.HALF_OPEN) {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.#transitionTo(BreakerState.CLOSED);
      }
      return;
    }

    this.consecutiveSuccesses = 0;
  }

  /**
   * Record a failed or timed-out primary call.
   * @param {Error|string} [error] retained for the metrics endpoint
   */
  recordFailure(error = null) {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    this.lastError = error ? String(error.message ?? error) : null;

    // A failure during a probe immediately re-opens: the primary is still sick,
    // and there is no value in spending more probes to confirm it.
    if (this.state === BreakerState.HALF_OPEN) {
      this.#trip();
      return;
    }

    if (
      this.state === BreakerState.CLOSED &&
      this.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.#trip();
    }
  }

  #trip() {
    this.totalTrips += 1;
    this.openedAt = this.now();
    this.#transitionTo(BreakerState.OPEN);
  }

  #transitionTo(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.lastStateChangeAt = this.now();

    if (nextState === BreakerState.CLOSED) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.openedAt = null;
    }
    if (nextState === BreakerState.HALF_OPEN) {
      this.consecutiveSuccesses = 0;
    }
  }

  /**
   * Snapshot for the metrics endpoint.
   *
   * Reports the state *as currently observed*, so an OPEN breaker past its
   * cooldown is reported as OPEN until a request actually probes it. This keeps
   * a read-only endpoint free of side effects.
   */
  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalTrips: this.totalTrips,
      openedAt: this.openedAt,
      lastStateChangeAt: this.lastStateChangeAt,
      lastError: this.lastError,
      cooldownRemainingMs:
        this.state === BreakerState.OPEN && this.openedAt !== null
          ? Math.max(0, this.config.cooldownMs - (this.now() - this.openedAt))
          : 0,
    };
  }

  /** Reset to a healthy CLOSED breaker. Used by tests and the admin reset path. */
  reset() {
    this.state = BreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    this.totalTrips = 0;
    this.lastError = null;
    this.lastStateChangeAt = this.now();
  }
}
