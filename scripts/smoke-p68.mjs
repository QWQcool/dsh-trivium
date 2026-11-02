/**
 * p68 — a blank assistant turn is recognised, and a tool-only step is not.
 *
 * Reproduced offline with a stub (W11): the model returns an empty text block,
 * the host reports turn_end "completed", the CLI exits 0 and the reply is empty.
 * The plugin cannot retry that model call, but it must not confuse "no answer"
 * with "a step that only called a tool", and it must leave a trace.
 */
import assert from 'node:assert/strict';

process.env.DSH_HOME = process.env.DSH_HOME || 'C:/Users/v_chchsli/AppData/Local/Temp/trivium-p68-home';
const plugin = await import('../lib/index.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const assistant = (content) => ({ type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content } } });

check(() => assert.equal(plugin.isEmptyAssistantAnswer(assistant([])), true), 'an empty content list is a blank answer');
check(() => assert.equal(plugin.isEmptyAssistantAnswer(assistant([{ type: 'text', text: '' }])), true), 'an empty text block is a blank answer');
check(() => assert.equal(plugin.isEmptyAssistantAnswer(assistant([{ type: 'text', text: '   \n ' }])), true), 'whitespace only is a blank answer');
check(() => assert.equal(plugin.isEmptyAssistantAnswer(assistant([{ type: 'text', text: 'B' }])), false), 'real text is not blank');
check(
  () => assert.equal(plugin.isEmptyAssistantAnswer(assistant([{ type: 'tool_use', id: 't1', name: 'ctx_find', input: {} }])), false),
  'a tool-only step is not a blank answer',
);
check(
  () => assert.equal(
    plugin.isEmptyAssistantAnswer(assistant([{ type: 'tool_use', id: 't1', name: 'ctx_find', input: {} }, { type: 'text', text: '' }])),
    false,
  ),
  'a tool step that also carries an empty text block is still a tool step',
);

console.log(`P68: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
