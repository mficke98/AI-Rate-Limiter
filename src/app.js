/**
 * Composition root.
 *
 * Builds one wired-up set of collaborators (limiter, breaker, models, metrics)
 * from a config object. Nothing below this file constructs its own dependencies,
 * which is what lets a test spin up a complete, isolated proxy with millisecond
 * windows and a tripwire-sensitive breaker without touching production defaults.
 *
 * See decision D17.
 */

import { createConfig } from './config.js';
import { SlidingWindowRateLimiter } from './rateLimiter.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { MetricsStore } from './metrics.js';
import { createModels } from './models.js';

/**
 * @param {object} [overrides] partial config, merged over the defaults
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock (decision D9)
 * @returns {{config: object, limiter: SlidingWindowRateLimiter, breaker: CircuitBreaker,
 *            metrics: MetricsStore, models: {primary: object, secondary: object}}}
 */
export function createApp(overrides = {}, { now = Date.now, random = Math.random } = {}) {
  const config = createConfig(overrides);

  return {
    config,
    limiter: new SlidingWindowRateLimiter({ config: config.rateLimit, now }),
    breaker: new CircuitBreaker({ config: config.circuitBreaker, now }),
    metrics: new MetricsStore({ now }),
    models: createModels(config, random),
  };
}
