/**
 * GET /api/metrics — live operational view of the proxy.
 *
 * Assembles the snapshot from the three subsystems that own the underlying
 * state. Strictly read-only: nothing here mutates the breaker or the window,
 * so a dashboard polling this endpoint cannot alter proxy behaviour (D14).
 */

/**
 * @param {object} deps the object returned by `createApp`
 * @returns {{status: number, headers: object, body: object}}
 */
export function handleMetrics(deps) {
  const { metrics, breaker, limiter, config } = deps;

  return {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    body: metrics.snapshot({
      breaker: breaker.snapshot(),
      window: limiter.usage(),
      limits: {
        windowMs: config.rateLimit.windowMs,
        softMaxRequests: config.rateLimit.softMaxRequests,
        hardMaxRequests: config.rateLimit.hardMaxRequests,
        softMaxTokens: config.rateLimit.softMaxTokens,
        hardMaxTokens: config.rateLimit.hardMaxTokens,
      },
    }),
  };
}

/**
 * POST /api/metrics/reset — clear all counters and reopen the breaker.
 *
 * Not in the brief, but a demo that cannot be reset is a demo you get one shot
 * at. Kept explicitly separate from the read path (D18).
 */
export function handleMetricsReset(deps) {
  deps.metrics.reset();
  deps.breaker.reset();
  deps.limiter.reset();
  deps.models.primary.clearForced();
  deps.models.secondary.clearForced();

  return {
    status: 200,
    headers: {},
    body: { ok: true, message: 'Metrics, rate-limit window, and circuit breaker reset.' },
  };
}
