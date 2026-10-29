import assert from 'node:assert/strict';
import { PRICING, priceBoth } from './pricing.mjs';

export function validUsage(u) {
  if (!u || !['prompt_tokens','completion_tokens'].every(k => Number.isInteger(u[k]) && u[k] >= 0)) return false;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return Number.isInteger(cached) && cached >= 0 && cached <= u.prompt_tokens;
}

/** All failures stop the experiment. Unknown charges retain their full reservation. */
export function createModelLedger({ report, save, budget, model, fetchImpl = fetch }) {
  assert.ok(PRICING[model], 'Unknown model price: refuse a paid run');
  let stopped = false;
  report.calls ||= []; report.reservedOrChargedCny ||= 0; report.estimatedCny ||= 0;
  return async function request(body, label) {
    assert.ok(!stopped, 'Experiment stopped; no further requests permitted');
    assert.equal(body.model, model); assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0);
    const price = PRICING[model].peak;
    const reserved = (Buffer.byteLength(JSON.stringify(body)) + 16384) * price.inputMiss / 1e6 + body.max_tokens * price.output / 1e6;
    const receipt = { label, state: 'reserved', reservedCny: reserved, request: body };
    try {
      assert.ok(report.reservedOrChargedCny + reserved <= budget, 'Budget exhausted before request');
      report.calls.push(receipt); report.reservedOrChargedCny += reserved; save();
      const response = await fetchImpl('https://api.deepseek.com/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}` }, body: JSON.stringify(body) });
      if (!response.ok) throw Error(`Provider HTTP ${response.status}`);
      const json = await response.json(), u = json.usage;
      receipt.model = json.model || model; receipt.response = json.choices; receipt.usage = u;
      assert.ok(PRICING[receipt.model], 'Unknown served-model price');
      assert.ok(validUsage(u), "Missing/invalid usage");
      assert.ok(json.choices?.[0]?.message, 'No model response');
      const both = priceBoth(u, receipt.model);
      assert.ok(both.peak <= reserved, 'Charge exceeded conservative reservation');
      receipt.costPeak = both.peak; receipt.costOffpeak = both.offpeak; receipt.state = 'complete';
      report.reservedOrChargedCny += both.peak - reserved; report.estimatedCny += both.offpeak; save();
      return { message: json.choices[0].message, usage: u, cost: both.peak, costOffpeak: both.offpeak };
    } catch (err) {
      stopped = true; receipt.error = err.message; receipt.state = 'stopped'; report.status = 'stopped'; report.error = err.message; save(); throw err;
    }
  };
}
