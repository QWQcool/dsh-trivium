/**
 * p91 — the version a reader is told about must be the version that exists.
 *
 * Every release used to leave one of these behind: README still said the previous
 * version, the index table pointed at an older tag, or the current-state page
 * described a release that was two versions old. The fix is not discipline, it is
 * a check that fails the suite.
 *
 * The candidate in package.json and the latest published npm package can
 * differ during release preparation. Check both sets of declarations offline.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const state = read('docs/CURRENT-STATE.md');
const published = /^\| npm 发布包 \|[^\r\n]*\x60latest = (\d+\.\d+\.\d+)\x60/m.exec(state)?.[1] || '';
const preparing = version !== published;
const escaping = published.replace(/\./g, '\\.');

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
  check(() => assert.match(read(file), pattern), `${what} names published ${published}`);
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
      assert.equal(found, published, `${file} claims "${found}" as the published version`);
    }
  }
}, 'no living document still advertises an older published version');

check(() => {
  assert.match(published, /^\d+\.\d+\.\d+$/, 'CURRENT-STATE needs one npm latest version');
  assert.ok(existsSync(join(ROOT, `docs/release-${published}.md`)), 'missing notes for the published version');
}, 'the current-state page names the published version');

check(() => {
  /*
   * "not published" is fine for the candidate, never for the published version.
   * A sentence like "no unpublished code" is not a stale claim, so the negative
   * forms are skipped before matching — this check is for the assertion, not for
   * the word.
   */
  for (const file of ['docs/README.md', 'docs/CURRENT-STATE.md']) {
    const lines = read(file).split('\n');
    const stale = lines.filter((line) => new RegExp(escaping).test(line)
      && /未发布|尚未发布|not published/i.test(line)
      && !/没有未发布|无未发布|不含未发布|no unpublished|0 个未发布|未发布的代码|unpublished code/i.test(line));
    assert.deepEqual(stale, [], `${file} calls ${published} unpublished: ${stale[0] || ''}`);
  }
}, 'the published version is not described as unpublished');

check(() => {
  const notes = read(`docs/release-${published}.md`);
  assert.doesNotMatch(notes, /待发布|尚未发布|not published/i, `docs/release-${published}.md still reads as a plan`);
}, 'the published release notes are written as a record');

check(() => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  for (const name of ['README.md', 'README.zh-CN.md', 'docs/README.md', 'docs/CURRENT-STATE.md']) {
    const candidateLine = read(name).split(/\r?\n/).find(line => /^(?:- (?:Local release candidate:|本地发布候选：)|\| 本地发布候选 \|)/.test(line));
    if (preparing) assert.ok(candidateLine?.includes(version), `${name} must name local candidate ${version}`);
    else assert.equal(candidateLine, undefined, `${name} still advertises a local candidate`);
  }
}, 'candidate declarations and lockfile agree with package.json');

check(() => {
  function markdownFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
    });
  }
  const files = ['README.md', 'README.zh-CN.md', 'PLAN.md', 'PLAN-session-map.md'].map(file => join(ROOT, file));
  files.push(...markdownFiles(join(ROOT, 'docs')));
  const missing = [];
  for (const file of files) {
    const prose = readFileSync(file, 'utf8').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) {
      const target = match[1] || match[2];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split(/[?#]/)[0]);
      const resolved = pathname.startsWith('/') ? resolve(ROOT, '.' + pathname) : resolve(dirname(file), pathname);
      if (!existsSync(resolved)) missing.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(missing, [], 'Missing local documentation targets:\n' + missing.join('\n'));
}, 'all local Markdown links and image targets exist');

console.log(`P91: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
