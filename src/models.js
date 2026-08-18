/**
 * Simulated model backends.
 *
 * The brief specifies a *simulated* primary model, and a circuit breaker cannot be
 * demonstrated or tested unless failures can be produced on demand. These stand in
 * for real LLM calls with configurable latency and controllable failure (decision D4).
 *
 * Swapping in a real provider means replacing the body of `invoke` with an HTTP
 * call — the timeout wrapper, the error shape, and every caller stay unchanged.
 */

/** Error thrown when a model exceeds its configured timeout. */
export class ModelTimeoutError extends Error {
  constructor(modelName, timeoutMs) {
    super(`${modelName} timed out after ${timeoutMs}ms`);
    this.name = 'ModelTimeoutError';
    this.modelName = modelName;
    this.timeoutMs = timeoutMs;
  }
}

/** Error thrown when a model returns an upstream failure. */
export class ModelFailureError extends Error {
  constructor(modelName, detail = 'upstream error') {
    super(`${modelName} failed: ${detail}`);
    this.name = 'ModelFailureError';
    this.modelName = modelName;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SimulatedModel {
  /**
   * @param {object} options
   * @param {object} options.config - a `models.primary` / `models.secondary` section
   * @param {() => number} [options.random] - injectable RNG, so failure-rate tests are deterministic
   */
  constructor({ config, random = Math.random }) {
    this.config = config;
    this.name = config.name;
    this.random = random;
    /** Forces the next N calls to fail. Simulation-only control (see D4). */
    this.forcedFailures = 0;
    /** Overrides latency for the next call, in ms. Simulation-only. */
    this.forcedLatencyMs = null;
  }

  /** Force the next `count` calls to fail. Used by the demo and by tests. */
  forceFailures(count) {
    this.forcedFailures = count;
  }

  /** Force the next call to take `ms`, which will trip the timeout if long enough. */
  forceLatency(ms) {
    this.forcedLatencyMs = ms;
  }

  /** Clear all forced behaviour and return to configured defaults. */
  clearForced() {
    this.forcedFailures = 0;
    this.forcedLatencyMs = null;
  }

  /** Whether this specific call should fail. */
  #shouldFail() {
    if (this.forcedFailures > 0) {
      this.forcedFailures -= 1;
      return true;
    }
    return this.random() < this.config.failureRate;
  }

  /**
   * Generate a completion for a prompt.
   *
   * Rejects with {@link ModelTimeoutError} if the call exceeds `timeoutMs`, or
   * {@link ModelFailureError} if the simulated upstream errors. Both are treated
   * identically by the circuit breaker, which is the point: from the proxy's
   * perspective a hung model and a broken model are the same problem.
   *
   * @param {string} prompt
   * @returns {Promise<{model: string, completion: string, latencyMs: number}>}
   */
  async invoke(prompt) {
    const startedAt = Date.now();
    const latency = this.forcedLatencyMs ?? this.config.latencyMs;
    this.forcedLatencyMs = null;

    const willFail = this.#shouldFail();

    // Race the simulated work against the timeout budget. A real HTTP client
    // would use an AbortController here; the structure is identical.
    const work = sleep(latency).then(() => {
      if (willFail) throw new ModelFailureError(this.name);
      return this.#completionFor(prompt);
    });

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ModelTimeoutError(this.name, this.config.timeoutMs)),
        this.config.timeoutMs,
      );
    });

    try {
      const completion = await Promise.race([work, timeout]);
      return { model: this.name, completion, latencyMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Canned response text. Deliberately different per model so a caller can see
   * which one served their request without reading the headers.
   */
  #completionFor(prompt) {
    const excerpt = prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
    if (this.name === 'primary-model') {
      return `[primary-model] Detailed tax analysis for: "${excerpt}". This response reflects full-depth reasoning across the applicable rules and their exceptions.`;
    }
    return `[secondary-model] Concise answer for: "${excerpt}". Lightweight fallback response; less depth than the primary model.`;
  }
}

/**
 * Build the primary/secondary pair from a config object.
 * @param {object} config - a full config from `createConfig`
 * @param {() => number} [random]
 */
export function createModels(config, random = Math.random) {
  return {
    primary: new SimulatedModel({ config: config.models.primary, random }),
    secondary: new SimulatedModel({ config: config.models.secondary, random }),
  };
}
