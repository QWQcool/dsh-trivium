/**
 * p91 — the version a reader is told about must be the version that exists.
 *
 * Every release used to leave one of these behind: README still said the previous
 * version, the index table pointed at an older tag, or the current-state page
 * described a release that was two versions old. The fix is not discipline, it is
 * a check that fails the suite.
 *
 * This pins the *declarations*, not the prose: where a document claims "the
 * published package is X", X has to be package.json's version, the matching
 * release notes have to exist, and the index has to agree.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try {
    fn();
    console.log('ok ' + label);
  } catch (err) {
    failures += 1;
    console.error('FAIL ' + label + ': ' + err.message);
  }
}

const version = JSON.parse(read('package.json')).version;
const escaping = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every "this is the published version" claim, as [file, regex, what]. */
const claims = [
  ['README.md', new RegExp(`The published npm package is \\*\\*${escaping}\\*\\*`), 'English banner'],
  ['README.md', new RegExp('Published package: `' + escaping + '`'), 'English release-info line'],
  ['README.zh-CN.md', new RegExp(`当前 npm 发布版是 \\*\\*${escaping}\\*\\*`), 'Chinese banner'],
  ['README.zh-CN.md', new RegExp('已发布包：`' + escaping + '`'), 'Chinese release-info line'],
  ['docs/README.md', new RegExp('`dsh-trivium@' + escaping + '`'), 'documentation index table'],
  ['docs/README.md', new RegExp('tag `v' + escaping + '`'), 'documentation index tag'],
];

for (const [file, pattern, what] of claims) {
  check(() => assert.match(read(file), pattern), `${what} names ${version}`);
}

check(() => {
  assert.ok(existsSync(join(ROOT, `docs/release-${version}.md`)), `missing docs/release-${version}.md`);
}, 'the release notes for the current version exist');

check(() => {
  const en = join(ROOT, `docs/release-${version}.en.md`);
  const previousEn = existsSync(join(ROOT, 'docs/release-0.8.7.en.md'));
  if (previousEn) assert.ok(existsSync(en), `missing docs/release-${version}.en.md`);
}, 'the English release notes exist when the previous release had them');

check(() => {
  // A stale claim: any *other* version presented as the published one.
  const files = ['README.md', 'README.zh-CN.md', 'docs/README.md'];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/published npm package is \*\*([0-9][^*]*)\*\*|当前 npm 发布版是 \*\*([0-9][^*]*)\*\*|已发布包：`([0-9][^`]*)`|Published package: `([0-9][^`]*)`/g)) {
      const found = (m[1] || m[2] || m[3] || m[4] || '').trim();
      assert.equal(found, version, `${file} still claims "${found}" as the published version`);
    }
  }
}, 'no living document still advertises an older published version');

check(() => {
  const state = read('docs/next-memory/CURRENT-STATE.md');
  assert.match(state, new RegExp(`latest = ${escaping}|latest=\`?${escaping}`), `CURRENT-STATE does not mention latest ${version}`);
}, 'the current-state page names the published version');

check(() => {
  /*
   * "not published" is fine for the *next* version, never for the current one.
   * A sentence like "no unpublished code" is not a stale claim, so the negative
   * forms are skipped before matching — this check is for the assertion, not for
   * the word.
   */
  for (const file of ['docs/README.md', 'docs/next-memory/CURRENT-STATE.md']) {
    const lines = read(file).split('\n');
    const stale = lines.filter((line) => new RegExp(escaping).test(line)
      && /未发布|尚未发布|not published/i.test(line)
      && !/没有未发布|无未发布|不含未发布|no unpublished|0 个未发布|未发布的代码|unpublished code/i.test(line));
    assert.deepEqual(stale, [], `${file} calls ${version} unpublished: ${stale[0] || ''}`);
  }
}, 'the current version is not described as unpublished');

check(() => {
  const notes = read(`docs/release-${version}.md`);
  // The notes have to say what shipped, not that it is planned.
  assert.doesNotMatch(notes, /待发布|尚未发布|not published/i, `docs/release-${version}.md still reads as a plan`);
}, 'the release notes are written as a record, not a plan');

console.log(`P91: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
