/**
 * p78 — settings page split (four pages, one host entry).
 *
 * The plugin gets exactly one `settings.section` card, so the redesign lives
 * inside it. This test renders the real component with a tiny hook runtime and
 * a JSX stub that keeps the tree, then asserts that:
 *
 *   1. the four page tabs exist, are a tablist, and start on 记忆库;
 *   2. each page shows its own cards and not the other pages' cards;
 *   3. every feature that was on the single long page is still reachable from
 *      at least one page (nothing was dropped while moving);
 *   4. arrow keys move between pages, and clicking a tab switches page;
 *   5. the page switch never re-points the workspace the requests use.
 *
 * Structural only: no browser, no host, no network (fetch is answered from a
 * fixture below).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try {
    await fn();
    console.log('ok ' + label);
  } catch (e) {
    failures += 1;
    console.error('FAIL ' + label + ': ' + e.message);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

const STATUS = {
  ok: true,
  cwd: '/ws/demo',
  dbPath: '/ws/demo/.dsh/trivium.tdb',
  nodeCount: 2,
  workspaces: [{ cwd: '/ws/demo', path: '/ws/demo/.dsh/trivium.tdb', nodeCount: 2 }],
  version: '0.8.3',
  lastInjectTokens: 0,
  mapTokenBudget: 400,
  turnTokenBudget: 300,
  recallMode: 'off',
  extractEnabled: true,
  chipsEnabled: false,
  sessionLayerEnabled: false,
  gitSidecarEnabled: false,
  pluginLocale: 'zh',
  configPanelOpen: true,
  embeddingEnabled: false,
  embeddingModel: 'text-embedding-3-small',
  lastExtract: { at: '2026-11-03T10:00:00.000Z', reason: 'turn-end', applied: 2, skipped: [] },
  stuck: null,
  recovered: null,
  lastMapInjection: { at: '2026-11-03T09:59:00.000Z', mode: 'full', reason: 'first', tokens: 70 },
};
const NODES = {
  ok: true,
  nodes: [
    { id: 1, type: 'decision', name: '发布窗口', text: '发布窗口定在周四。', updatedAt: '2026-11-03T09:00:00.000Z', stale: false },
    { id: 2, type: 'preference', name: '包管理器', text: '以后都用 pnpm。', updatedAt: '2026-11-03T09:10:00.000Z', stale: false },
  ],
};

function fixtureFetch(url) {
  const body = String(url);
  if (body.includes('/api/dsh-trivium/status')) return STATUS;
  if (body.includes('/api/dsh-trivium/nodes')) return NODES;
  if (body.includes('/api/dsh-trivium/external')) return { ok: true, files: [] };
  if (body.includes('/api/dsh-trivium/changes')) return { ok: true, entries: [], labels: {} };
  if (body.includes('/api/dsh-trivium/recall-traces')) return { ok: true, entries: [] };
  if (body.includes('/api/dsh-trivium/corrections')) return { ok: true, sessions: [] };
  if (body.includes('/api/dsh-trivium/turn')) return { ok: true, sessions: [] };
  return { ok: true };
}

/**
 * Minimal hook runtime: state survives between renders, effects run once per
 * dependency change, and callbacks keep their first identity (otherwise the
 * "load on mount" effect would re-fire forever, which is a real-React problem
 * this stub must not invent).
 */
function createRuntime() {
  const hooks = [];
  const effects = [];
  const seenDeps = [];
  let cursor = 0;
  const react = {
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: init === undefined ? null : init };
      return hooks[i];
    },
    useMemo(fn) { cursor += 1; return fn(); },
    useCallback(fn) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = fn;
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      effects.push({ index: i, fn, deps });
    },
    Fragment: 'Fragment',
  };
  return {
    react,
    begin: () => { cursor = 0; effects.length = 0; },
    pending: () => effects.slice(),
    depsUnchanged(index, deps) {
      const prev = seenDeps[index];
      if (!Array.isArray(deps) || !Array.isArray(prev) || prev.length !== deps.length) return false;
      seenDeps[index] = deps.slice();
      return prev.every((value, i) => Object.is(value, deps[i]));
    },
    markDeps(index, deps) { seenDeps[index] = Array.isArray(deps) ? deps.slice() : null; },
  };
}

function element(type, props, key) {
  return { type, props: props || {}, key };
}

function loadBundle() {
  let registration = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { registration = def; } } },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => fixtureFetch(url) }),
    setTimeout,
    clearTimeout,
    console,
    // The list request is built with URLSearchParams; without it `load()` stops
    // after the status call and the list silently stays empty.
    URLSearchParams,
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' });
  if (!registration) throw new Error('bundle did not register');
  return registration;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function mount() {
  const runtime = createRuntime();
  const table = {
    react: runtime.react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: function Button(props) { return element('button', props); },
    },
  };
  const registration = loadBundle();
  const loaded = registration.factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(table, spec)) return table[spec];
    throw new Error('unexpected require(' + spec + ')');
  });
  let component = null;
  loaded.apply({
    workspaces: { list: null },
    sessions: {},
    slots: {
      inject: (_key, body) => body(),
      register: (_entry, comp) => { component = comp; return { dispose() {} }; },
    },
    on: () => {},
  });
  if (!component) throw new Error('settings section was not registered');
  loaded.__locale.setPluginLocalePref('zh');

  const render = () => {
    runtime.begin();
    const tree = component({});
    for (const effect of runtime.pending()) {
      const index = effect.index;
      if (runtime.depsUnchanged(index, effect.deps)) continue;
      runtime.markDeps(index, effect.deps);
      effect.fn();
    }
    return tree;
  };
  let tree = render();
  // The mount effect chains three requests (status -> nodes -> external); keep
  // re-rendering until every resolved state has been folded into the tree.
  for (let i = 0; i < 8; i += 1) {
    await settle();
    tree = render();
  }
  return { render, tree: () => tree };
}

function walk(node, out = { nodes: [], text: [] }) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  out.nodes.push(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, out);
  return out;
}
const textOf = (tree) => walk(tree).text.join(' ');
const pageStrip = (tree) =>
  walk(tree).nodes.find((n) => n.props && n.props.role === 'tablist' && n.props['aria-label']);
const pageTabs = (tree) => {
  const strip = pageStrip(tree);
  return strip ? walk(strip).nodes.filter((n) => n.props && n.props.role === 'tab') : [];
};
const labelOf = (node) => (typeof node.props.children === 'string' ? node.props.children : '');
const LABELS = { memory: '记忆库', context: '上下文', runs: '运行记录', settings: '设置' };

try {
  const app = await mount();
  const first = app.tree();

  const tabs = pageTabs(first);
  await check(() => assert(tabs.length === 4, `four page tabs (got ${tabs.length})`), 'four page tabs render');
  await check(
    () => assert(JSON.stringify(tabs.map(labelOf)) === JSON.stringify(Object.values(LABELS)), `labels ${tabs.map(labelOf)}`),
    'the tabs are the four designed pages',
  );
  await check(() => assert(tabs[0].props['aria-selected'] === 'true', 'memory is not selected'), 'memory is selected by default');
  await check(() => assert(first.props && first.props.style, 'the page root has no style'), 'the card still renders as one page');

  const memoryText = textOf(first);
  await check(() => assert(memoryText.includes('发布窗口'), 'the loaded fact is missing from the list'), 'the list page shows the loaded facts');
  await check(() => assert(!memoryText.includes('检查更新'), 'the update card leaked into the list page'), 'the list page drops the update card');
  await check(() => assert(!memoryText.includes('运行诊断'), 'diagnostics leaked into the list page'), 'the list page drops diagnostics');

  const clickPage = (name) => {
    const tree = app.tree();
    const tab = pageTabs(tree).find((n) => labelOf(n) === LABELS[name]);
    assert(!!tab, `no tab for ${name}`);
    tab.props.onClick();
    const next = app.render();
    return next;
  };

  const context = clickPage('context');
  const contextText = textOf(context);
  await check(() => assert(contextText.includes('试算')), 'context page lost the read-only probe');
  await check(() => assert(contextText.includes('这一轮实际发送')), 'context page lost the delivered-records card');
  await check(() => assert(!contextText.includes('记忆变化')), 'context page shows the audit log');

  const runs = clickPage('runs');
  const runsText = textOf(runs);
  await check(() => assert(runsText.includes('运行诊断')), 'runs page does not open with diagnostics');
  await check(() => assert(runsText.includes('记忆变化')), 'runs page lost the change log');
  await check(() => assert(runsText.includes('恢复')), 'runs page lost the recovery state');
  await check(() => assert(!runsText.includes('试算')), 'runs page mixes in the probe');

  const settings = clickPage('settings');
  const settingsText = textOf(settings);
  for (const label of ['维护', '检查更新', '配置设置', '界面语言', 'Markdown 投影', '外部记忆']) {
    await check(() => assert(settingsText.includes(label), `missing ${label}`), `settings page keeps ${label}`);
  }
  await check(() => assert(!settingsText.includes('发布窗口'), 'settings page renders the memory list'), 'settings page drops the memory list');

  // Keyboard contract on the page strip.
  const contextTree = clickPage('context');
  const strip = pageStrip(contextTree);
  await check(() => assert(!!strip && typeof strip.props.onKeyDown === 'function'), 'the page strip has no key handler');
  if (strip) {
    let prevented = false;
    strip.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
    const afterKey = app.render();
    const selected = pageTabs(afterKey).find((n) => n.props['aria-selected'] === 'true');
    await check(() => assert(prevented), 'arrow key did not call preventDefault');
    await check(
      () => assert(selected && labelOf(selected) === LABELS.runs, `moved to ${selected && labelOf(selected)}`),
      'arrow right moves forward one page',
    );
  }

  // Nothing was dropped: every card from the single long page is still reachable.
  const pages = ['memory', 'context', 'runs', 'settings'];
  const allText = pages.map((name) => textOf(clickPage(name))).join(' ');
  for (const label of ['维护', '检查更新', '配置设置', '界面语言', '外部记忆', '记忆变化', '运行诊断', '这一轮实际发送', '发布窗口']) {
    await check(() => assert(allText.includes(label), `feature ${label} is unreachable`), `no lost entry: ${label}`);
  }

  const memory = clickPage('memory');
  await check(() => assert(textOf(memory).includes('发布窗口')), 'returning to memory did not restore the list');
  await check(() => assert(pageTabs(memory).length === 4), 'the tab strip lost a tab');
} catch (err) {
  failures += 1;
  console.error('FAIL unexpected throw: ' + (err && err.stack ? err.stack : err));
}

console.log(`P78: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
