/**
 * p45 — extraction asks for reasoning "off", but never depends on it.
 *
 * A-3 baseline (real model): 12 of 18 extraction calls ended
 * stop_reason=max_tokens even with a 900-token budget, because reasoning ate the
 * budget before any JSON was written. Extraction is a JSON errand, so it requests
 * the "off" effort and retries once without it when the host's catalog does not
 * advertise that effort (an unknown effort must not disable extraction).
 */
import assert from 'node:assert/strict';

process.env.DSH_HOME = 'C:/nonexistent-p45-home';
const { makeLlmCall } = await import('../lib/index.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}
async function checkAsync(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const session = { id: 'session-p45', requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) };

function host({ failFirst }) {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(JSON.parse(JSON.stringify(options)));
      if (failFirst && calls.length === 1) {
        return (async function* () {
          const err = new Error('provider "x" model "y" does not support reasoning effort "off"');
          err.code = 'UNSUPPORTED_REASONING_EFFORT';
          throw err;
        })();
      }
      return (async function* () {
        throw new Error('stop-here');
      })();
    },
  };
  return { calls, ctx: { llm } };
}

// 1. happy path: first attempt asks for the off effort and a 900-token budget
{
  const { calls, ctx } = host({ failFirst: false });
  const call = makeLlmCall(ctx, session, null);
  await call('prompt').catch(() => {});
  check(() => assert.equal(calls.length, 1), 'one attempt when the host accepts the effort');
  check(() => assert.equal(calls[0].reasoningEffort, 'off'), 'extraction asks for reasoning off');
  check(() => assert.equal(calls[0].maxTokens, 900), 'extraction keeps the 900-token budget');
  check(() => assert.equal(calls[0].provider, 'deepseek-official'), 'provider comes from the session header');
}

// 2. unknown effort: retry once without it, everything else unchanged
{
  const { calls, ctx } = host({ failFirst: true });
  const call = makeLlmCall(ctx, session, null);
  await checkAsync(async () => {
    await assert.rejects(() => call('prompt'), /stop-here/);
  }, 'the retry error still propagates');
  check(() => assert.equal(calls.length, 2), 'exactly one fallback attempt');
  check(() => assert.equal(calls[1].reasoningEffort, undefined), 'the fallback drops the effort');
  check(() => assert.equal(calls[1].maxTokens, 900), 'the fallback keeps the budget');
  check(() => assert.equal(calls[1].model, 'deepseek-flash'), 'the fallback keeps the model');
}

// 3. an unrelated error is not retried
{
  const { calls, ctx } = host({ failFirst: false });
  const call = makeLlmCall(ctx, session, null);
  await checkAsync(async () => {
    await assert.rejects(() => call('prompt'), /stop-here/);
  }, 'unrelated errors propagate');
  check(() => assert.equal(calls.length, 1), 'unrelated errors are not retried');
}

console.log(`P45: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
