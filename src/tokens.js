/**
 * Token estimation.
 *
 * A real gateway would use the provider's tokenizer. This prototype must not
 * depend on one (decision D1), so we approximate with the widely used
 * ~4-characters-per-token heuristic for English text.
 *
 * The estimate only needs to be *proportional* to real usage: the limiter
 * compares it against a budget we set ourselves, so a consistent bias is
 * harmless where an inconsistent one would not be.
 */

const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a string.
 * Always returns at least 1 for non-empty input, so no request is free.
 *
 * @param {string} text
 * @returns {number} estimated tokens, never negative
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.trim().length / CHARS_PER_TOKEN));
}

/**
 * Total tokens attributable to one request/response exchange.
 *
 * @param {string} prompt
 * @param {string} completion
 * @returns {{prompt: number, completion: number, total: number}}
 */
export function accountTokens(prompt, completion = '') {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completion);
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens,
  };
}
