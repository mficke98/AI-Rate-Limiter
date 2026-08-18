/**
 * POST /api/generate — the proxy endpoint.
 *
 * Orchestrates the three subsystems in a fixed order. Every routing rule the
 * system has lives in this one function, so the complete behaviour can be read
 * top to bottom in one place.
 *
 * Outcome table (decision D2):
 *
 *   | condition                          | backend   | status | X-Fallback-Applied |
 *   |------------------------------------|-----------|--------|--------------------|
 *   | within budget, primary healthy     | primary   | 200    | false              |
 *   | over soft limit                    | secondary | 200    | true               |
 *   | over hard limit                    | none      | 429    | (absent)           |
 *   | primary errored / timed out        | secondary | 200    | true               |
 *   | breaker OPEN                       | secondary | 200    | true               |
 *   | primary and secondary both failed  | none      | 503    | true               |
 */

import { Decision } from '../rateLimiter.js';
import { accountTokens, estimateTokens } from '../tokens.js';
import { ModelTimeoutError } from '../models.js';

/** Reasons a request ended up on the secondary model. */
export const FallbackReason = Object.freeze({
  SOFT_REQUEST_LIMIT: 'soft_request_limit_exceeded',
  SOFT_TOKEN_LIMIT: 'soft_token_limit_exceeded',
  PRIMARY_ERROR: 'primary_error',
  PRIMARY_TIMEOUT: 'primary_timeout',
  CIRCUIT_OPEN: 'circuit_open',
});

/**
 * Apply simulation-only overrides carried on the request body.
 *
 * This is a test/demo control surface on a production-shaped endpoint. It is
 * documented as such in D4 and would be removed before any real deployment.
 */
function applySimulation(models, simulate) {
  if (!simulate || typeof simulate !== 'object') return;
  if (simulate.primaryFails) models.primary.forceFailures(Number(simulate.primaryFails) || 1);
  if (simulate.primaryLatencyMs) models.primary.forceLatency(Number(simulate.primaryLatencyMs));
  if (simulate.secondaryFails) models.secondary.forceFailures(Number(simulate.secondaryFails) || 1);
}

/**
 * @param {object} deps the object returned by `createApp`
 * @param {object} body the parsed JSON request body
 * @returns {Promise<{status: number, headers: object, body: object}>}
 */
export async function handleGenerate(deps, body) {
  const { limiter, breaker, metrics, models } = deps;

  // ---- 1. Validate -------------------------------------------------------
  // Rejected before any counter moves: a malformed request is the client's
  // error, and should not consume the budget of a well-behaved one.
  const prompt = body?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return {
      status: 400,
      headers: {},
      body: {
        error: 'invalid_request',
        message: 'Body must include a non-empty "prompt" string.',
      },
    };
  }

  metrics.recordRequest();
  applySimulation(models, body.simulate);

  // ---- 2. Budget check ---------------------------------------------------
  const estimated = estimateTokens(prompt);
  const verdict = limiter.check(estimated);

  if (verdict.decision === Decision.REJECT) {
    // Load shed. No model is called, and nothing is recorded against the
    // window — a request we refused should not deepen the client's own hole.
    metrics.recordRejected();
    return {
      status: 429,
      headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
      body: {
        error: 'rate_limit_exceeded',
        message:
          'Request budget exhausted. The proxy is shedding load to protect the upstream gateway.',
        reason: verdict.reason,
        retryAfterSeconds: verdict.retryAfterSeconds,
        usage: verdict.usage,
      },
    };
  }

  // ---- 3. Choose a backend ----------------------------------------------
  let fallbackReason = null;

  if (verdict.decision === Decision.DEGRADE) {
    // Over the soft limit: skip the primary deliberately. The client still gets
    // an answer, just a cheaper one.
    fallbackReason = verdict.reason;
  } else if (!breaker.allowsPrimary()) {
    // Breaker is OPEN. Skipping the primary entirely is the whole point — we
    // avoid paying its timeout on a call we already expect to fail.
    fallbackReason = FallbackReason.CIRCUIT_OPEN;
  } else {
    // ---- 4. Try the primary ---------------------------------------------
    try {
      const result = await models.primary.invoke(prompt);
      breaker.recordSuccess();
      metrics.recordPrimarySuccess(result.latencyMs);
      return finish(deps, {
        prompt,
        result,
        fallbackApplied: false,
        fallbackReason: null,
        verdict,
      });
    } catch (error) {
      const timedOut = error instanceof ModelTimeoutError;
      breaker.recordFailure(error);
      metrics.recordPrimaryFailure({ timedOut });
      fallbackReason = timedOut ? FallbackReason.PRIMARY_TIMEOUT : FallbackReason.PRIMARY_ERROR;
    }
  }

  // ---- 5. Fall back to the secondary ------------------------------------
  try {
    const result = await models.secondary.invoke(prompt);
    metrics.recordFallback(fallbackReason, result.latencyMs);
    return finish(deps, {
      prompt,
      result,
      fallbackApplied: true,
      fallbackReason,
      verdict,
    });
  } catch (error) {
    // Both backends are down. 503, not 429: the client is not sending too much,
    // we simply cannot serve anyone right now (decision D2).
    metrics.recordTotalFailure();
    limiter.record(estimated);
    return {
      status: 503,
      headers: { 'X-Fallback-Applied': 'true' },
      body: {
        error: 'all_backends_unavailable',
        message:
          'Both the primary and the fallback model failed. No response could be generated.',
        fallbackReason,
        detail: String(error.message ?? error),
      },
    };
  }
}

/**
 * Shared success path: account for tokens, commit usage to the window, and
 * shape the response. Centralised so the primary and fallback paths cannot
 * drift apart in what they record.
 */
function finish(deps, { prompt, result, fallbackApplied, fallbackReason, verdict }) {
  const tokens = accountTokens(prompt, result.completion);
  deps.metrics.recordTokens(tokens);
  // Committed only now, with the real token cost rather than the estimate (D10).
  deps.limiter.record(tokens.total);

  return {
    status: 200,
    headers: { 'X-Fallback-Applied': String(fallbackApplied) },
    body: {
      model: result.model,
      completion: result.completion,
      fallbackApplied,
      fallbackReason,
      latencyMs: result.latencyMs,
      tokens,
      rateLimit: {
        decision: verdict.decision,
        usage: deps.limiter.usage(),
      },
      circuitBreaker: deps.breaker.state,
    },
  };
}
