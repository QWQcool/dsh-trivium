/**
 * p46 — credential values are refused on the way into the database, and the
 * refusal is reported instead of silently dropping the fact.
 *
 * A-3 showed the extractor no longer redacts credential-shaped text by itself
 * once extraction runs with reasoning off, so the gate must recognise the shapes.
 * The refusal must not echo the secret back into logs or status either.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p46-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const { looksSecret } = await import('../lib/schema.js');
const hygiene = await import('../lib/hygiene.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

// 1. credential shapes are recognised
for (const [label, value] of [
  ['github pat', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['github fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
  ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
  ['google api key', 'AIzaSyD-abcdefghijklmnopqrstuvwxyz012345'],
  ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['slack token', 'xoxb-1234567890-abcdefghijkl'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['pem', '-----BEGIN RSA PRIVATE KEY-----'],
  ['chinese password', '数据库密码：Zx9q2Wm7'],
  ['chinese code word', '发布前置校验口令 verify-QA-71'],
]) {
  check(() => assert.equal(looksSecret(value), true), 'refuses ' + label);
}

// 2. ordinary facts are not mistaken for credentials
for (const [label, value] of [
  ['project code name', '本次发布代号是 BlueHeron。'],
  ['port', '生产端口是 9443。'],
  ['person', '项目负责人是张三。'],
  ['password topic without a value', '密码学很难，团队还在补课。'],
  ['budget', '预算上限是 5000 元。'],
  ['hash in prose', '清单的 sha256 已核对过。'],
]) {
  check(() => assert.equal(looksSecret(value), false), 'keeps ' + label);
}

// 3. the extraction path refuses the candidate and reports it
const cwd = join(root, 'ws');
const db = await store.openWorkspaceDb(cwd);
const result = await extract.distill({
  db,
  turns: [{ role: 'user', text: '我的部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789，记住它。' }],
  sessionId: 'p46',
  llmCall: async () => JSON.stringify({
    candidates: [
      { type: 'preference', name: '部署密钥', text: '部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789。' },
      { type: 'decision', name: '部署目标', text: '部署目标是预发环境。' },
    ],
  }),
});
check(() => assert.equal(result.applied.length, 1), 'the clean candidate is written');
check(() => assert.equal(result.applied[0].text, '部署目标是预发环境。'), 'the written candidate is the clean one');
check(() => assert.equal(result.skipped.length, 1), 'the secret candidate is reported as skipped');
check(() => assert.equal(result.skipped[0].reason, 'secret'), 'skip reason is secret');
check(() => assert.equal(result.skipped[0].preview, '<redacted>'), 'the skip report does not echo the secret');
check(() => assert.equal(typeof result.skipped[0].length, 'number'), 'the skip report keeps only a length');
const stored = db.allNodeIds().map((id) => String(db.get(id)?.payload?.text || '')).join('\n');
check(() => assert.doesNotMatch(stored, /ghp_/), 'no credential reached the database');
check(() => assert.match(stored, /预发环境/), 'the clean fact did reach the database');

// 4. the write gate used by ctx_remember shares the same rule
check(() => assert.equal(hygiene.sanitizeForWrite('部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789').ok, false), 'ctx_remember gate refuses the same value');
check(() => assert.equal(hygiene.sanitizeForWrite('部署目标是预发环境。').ok, true), 'ctx_remember gate keeps the clean fact');

store.closeAll();
rmSync(root, { recursive: true, force: true });
console.log(`P46: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
