import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimulatedModel,
  createModels,
  ModelTimeoutError,
  ModelFailureError,
} from '../src/models.js';
import { createConfig } from '../src/config.js';

/** Fast latencies keep the suite quick; the logic under test is latency-agnostic. */
function build(overrides = {}, random = () => 1) {
  const config = createConfig({
    models: {
      primary: { name: 'primary-model', latencyMs: 5, timeoutMs: 100, failureRate: 0, ...overrides },
    },
  }).models.primary;
  return new SimulatedModel({ config, random });
}

describe('SimulatedModel - happy path', () => {
  test('returns a completion, the model name, and a latency measurement', async () => {
    const model = build();
    const result = await model.invoke('What is the capital gains rate?');
    assert.equal(result.model, 'primary-model');
    assert.ok(result.completion.includes('primary-model'));
    assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0);
  });

  test('echoes the prompt so the caller can see which request was answered', async () => {
    const model = build();
    const result = await model.invoke('deduction question');
    assert.ok(result.completion.includes('deduction question'));
  });

  test('truncates very long prompts in the echoed completion', async () => {
    const model = build();
    const result = await model.invoke('x'.repeat(500));
    assert.ok(result.completion.includes('...'));
    assert.ok(result.completion.length < 400);
  });

  test('the secondary model is distinguishable from the primary', async () => {
    const { secondary } = createModels(createConfig({
      models: { secondary: { name: 'secondary-model', latencyMs: 5, timeoutMs: 100, failureRate: 0 } },
    }));
    const result = await secondary.invoke('question');
    assert.equal(result.model, 'secondary-model');
    assert.ok(result.completion.includes('secondary-model'));
    assert.ok(result.completion.toLowerCase().includes('fallback'));
  });
});

describe('SimulatedModel - failure injection', () => {
  test('forceFailures makes exactly the next N calls fail', async () => {
    const model = build();
    model.forceFailures(2);
    await assert.rejects(() => model.invoke('a'), ModelFailureError);
    await assert.rejects(() => model.invoke('b'), ModelFailureError);
    const recovered = await model.invoke('c');
    assert.equal(recovered.model, 'primary-model');
  });

  test('a failureRate of 1 always fails', async () => {
    const model = build({ failureRate: 1 }, () => 0);
    await assert.rejects(() => model.invoke('a'), ModelFailureError);
  });

  test('a failureRate of 0 never fails, even with an unlucky RNG', async () => {
    const model = build({ failureRate: 0 }, () => 0);
    const result = await model.invoke('a');
    assert.ok(result.completion);
  });

  test('the failure error names the model that failed', async () => {
    const model = build();
    model.forceFailures(1);
    await assert.rejects(() => model.invoke('a'), (err) => {
      assert.equal(err.modelName, 'primary-model');
      assert.equal(err.name, 'ModelFailureError');
      return true;
    });
  });

  test('clearForced cancels pending forced failures', async () => {
    const model = build();
    model.forceFailures(5);
    model.clearForced();
    const result = await model.invoke('a');
    assert.ok(result.completion);
  });
});

describe('SimulatedModel - timeouts', () => {
  test('rejects with ModelTimeoutError when latency exceeds the budget', async () => {
    const model = build({ timeoutMs: 20 });
    model.forceLatency(200);
    await assert.rejects(() => model.invoke('slow'), ModelTimeoutError);
  });

  test('the timeout error records the model and the budget it exceeded', async () => {
    const model = build({ timeoutMs: 20 });
    model.forceLatency(200);
    await assert.rejects(() => model.invoke('slow'), (err) => {
      assert.equal(err.name, 'ModelTimeoutError');
      assert.equal(err.modelName, 'primary-model');
      assert.equal(err.timeoutMs, 20);
      return true;
    });
  });

  test('forced latency applies to one call only', async () => {
    const model = build({ timeoutMs: 50 });
    model.forceLatency(200);
    await assert.rejects(() => model.invoke('slow'), ModelTimeoutError);
    const result = await model.invoke('fast');
    assert.ok(result.completion, 'the next call should use configured latency');
  });

  test('latency just under the budget still succeeds', async () => {
    const model = build({ latencyMs: 5, timeoutMs: 200 });
    const result = await model.invoke('ok');
    assert.ok(result.completion);
  });
});

describe('createModels', () => {
  test('builds a primary/secondary pair from one config', () => {
    const models = createModels(createConfig());
    assert.equal(models.primary.name, 'primary-model');
    assert.equal(models.secondary.name, 'secondary-model');
  });

  test('the secondary is configured to be faster than the primary', () => {
    const models = createModels(createConfig());
    assert.ok(models.secondary.config.latencyMs < models.primary.config.latencyMs,
      'the fallback must be the lightweight option, or fallback buys nothing');
  });
});
