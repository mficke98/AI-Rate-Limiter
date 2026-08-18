/**
 * Every tunable value in the system lives here.
 *
 * Why one file: the limiter, breaker, and model simulators are all timing-sensitive.
 * Tests need short windows (milliseconds) while production wants realistic ones
 * (minutes). Centralising the knobs lets a test build a fast config without
 * touching the logic under test. See decision D5.
 */

/** Production defaults. */
export const defaultConfig = Object.freeze({
  server: {
    port: Number(process.env.PORT) || 3000,
  },

  rateLimit: {
    /** Width of the sliding window in milliseconds. */
    windowMs: 60_000,
    /**
     * Requests per window before we degrade to the secondary model.
     * The brief's stated example: max 5 requests per minute.
     */
    softMaxRequests: 5,
    /** Requests per window before we shed load outright with a 429. */
    hardMaxRequests: 15,
    /** Tokens per window before we degrade to the secondary model. */
    softMaxTokens: 2_000,
    /** Tokens per window before we shed load outright with a 429. */
    hardMaxTokens: 6_000,
  },

  circuitBreaker: {
    /** Consecutive primary failures required to trip the breaker OPEN. */
    failureThreshold: 3,
    /** How long the breaker stays OPEN before allowing a probe request. */
    cooldownMs: 10_000,
    /** Consecutive successes in HALF_OPEN required to close the breaker. */
    successThreshold: 2,
  },

  models: {
    primary: {
      name: 'primary-model',
      /** Simulated processing latency. */
      latencyMs: 120,
      /** Requests slower than this are treated as timed-out failures. */
      timeoutMs: 1_000,
      /** 0 = never fail. Raise to simulate an unhealthy upstream. */
      failureRate: 0,
    },
    secondary: {
      name: 'secondary-model',
      latencyMs: 40,
      timeoutMs: 1_000,
      failureRate: 0,
    },
  },
});

/**
 * Build a config by overlaying partial overrides on the defaults.
 * Merges two levels deep, which is exactly the shape of the config tree.
 *
 * @param {object} [overrides]
 * @returns {typeof defaultConfig}
 */
export function createConfig(overrides = {}) {
  const merged = {};
  for (const [section, values] of Object.entries(defaultConfig)) {
    merged[section] = { ...values, ...(overrides[section] ?? {}) };
    // Model config is one level deeper than the rest.
    if (section === 'models') {
      merged.models = {
        primary: { ...defaultConfig.models.primary, ...(overrides.models?.primary ?? {}) },
        secondary: { ...defaultConfig.models.secondary, ...(overrides.models?.secondary ?? {}) },
      };
    }
  }
  return merged;
}
