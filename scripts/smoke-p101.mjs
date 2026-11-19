/**
 * p101 — entity-scoped search card: user-visible behaviour under controlled replies.
 *
 * p78 only executes the card as part of the context page; p93 covers the backend
 * contract. This file drives the real component (same JSX/hook stub as p78) with a
 * reply-controlled fetch so the panel itself is asserted on:
 *
 *   1. default cost: semantic off, one POST, only endpoint fields, no embedding call;
 *   2. two channels stay separate and answerability is always shown;
 *   3. empty scope (`scope_anchor_only`, `no_candidates`) is not rendered as an answer;
 *   4. workspace A -> B drops the old input/result and a late A reply never lands in B;
 *   5. out-of-order replies inside one workspace: the older reply cannot overwrite;
 *   6. fixed snapshot keeps captured text; a missing snapshot does not fall back to live;
 *   7. 400/404/408/409/422/429 render distinct states, one request each, no auto retry;
 *   8. a degraded semantic channel keeps the lexical candidates and names the reason.
 *
 * Evidence level: controlled component test (no browser, no host, no network).
 * Real-desktop results are recorded separately in docs/reviews.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

const ALPHA = '/ws/alpha';
const BETA = '/ws/beta';

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

function workspaceStatus(cwd, other, nodeCount) {
  return {
    ok: true,
    cwd,
    dbPath: cwd + '/.dsh/trivium.tdb',
    nodeCount,
    workspaces: [
      { cwd: ALPHA, path: ALPHA + '/.dsh/trivium.tdb', nodeCount: 2 },
      { cwd: BETA, path: BETA + '/.dsh/trivium.tdb', nodeCount: 1 },
    ],
    version: '0.8.9',
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
    embeddingModel: 'local-test-double',
    lastExtract: null,
    stuck: null,
    recovered: null,
    lastMapInjection: null,
    other,
  };
}

const NODES = {
  [ALPHA]: { ok: true, nodes: [{ id: 1, type: 'entity', name: 'Alpha 服务', text: 'Alpha 的合成事实。' }] },
  [BETA]: { ok: true, nodes: [{ id: 2, type: 'entity', name: 'Beta 服务', text: 'Beta 的合成事实。' }] },
};

function cwdOf(url) {
  try {
    return new URL(url, 'http://local.invalid').searchParams.get('cwd') || '';
  } catch {
    return '';
  }
}

function response(status, payload) {
  return { ok: status < 400, status, json: async () => payload };
}

/** A reply-controlled HTTP layer: entity-search requests stay pending until the test answers. */
function createServer({withPending=false, damagedCwd}={}) {
  const calls = [];
  const searches = [];
  const reviews = [];
  const documents = [];
  const historyRows = {[ALPHA]:[],[BETA]:[]};
  const pendingRows = Object.fromEntries([ALPHA,BETA].map((cwd,index)=>[cwd,withPending ? [{sessionId:'same-session',turns:1,preview:cwd,
    etag:String(index+1).repeat(64),evidence:[{role:'user',text:'格式是什么？'}],unverified:[{id:'a'.repeat(64),type:'decision',name:'格式',text:cwd+' 格式是 XLSX。',quote:'格式是什么？'}]}] : []]));
  let liveText = '报告游标可以复用 24 小时。';
  const fetchImpl = async (url, opts) => {
    const href = String(url);
    calls.push({ href, opts });
    if(href.includes('/api/dsh-trivium/document-evidence'))return new Promise(resolve=>documents.push({href,body:opts?.body?JSON.parse(opts.body):null,reply(status,payload){resolve(response(status,payload));}}));
    if(href.includes('/api/dsh-trivium/pending/review')) return new Promise(resolve=>reviews.push({href,body:JSON.parse(opts.body),reply(status,payload){resolve(response(status,payload));}}));
    if (href.includes('/api/dsh-trivium/entity-search')) {
      return new Promise((resolve) => {
        searches.push({
          href,
          cwd: cwdOf(href),
          body: JSON.parse((opts && opts.body) || '{}'),
          reply(status, payload) { resolve(response(status, payload)); },
        });
      });
    }
    if (href.includes('/api/dsh-trivium/status')) {
      const cwd = cwdOf(href) || ALPHA;
      const status = cwd === BETA ? workspaceStatus(BETA, ALPHA, 1) : workspaceStatus(ALPHA, BETA, 2);
      if (cwd === damagedCwd) {
        status.dbHealth = {state: 'corrupt', code: 'DB_CORRUPTED', detail: 'Synthetic damaged TDB header'};
        status.nodeCount = null;
      }
      return response(200, status);
    }
    if (href.includes('/api/dsh-trivium/nodes')) {
      return response(200, NODES[cwdOf(href)] || NODES[ALPHA]);
    }
    if (href.includes('/api/dsh-trivium/external')) return response(200, { ok: true, files: [] });
    if (href.includes('/api/dsh-trivium/changes')) return response(200, { ok: true, entries: [], labels: {} });
    if (href.includes('/api/dsh-trivium/pending')) {const scope=cwdOf(href)||ALPHA,rows=pendingRows[scope],offset=Number(new URL(href,'http://local.invalid').searchParams.get('reviewOffset')||0);
      return response(200, { ok: true, windows:rows, turns:rows.length, acknowledged: 0,history:{offset,limit:20,total:historyRows[scope].length,entries:historyRows[scope].slice(offset,offset+20)} });}
    if (href.includes('/api/dsh-trivium/recall-traces')) return response(200, { ok: true, entries: [] });
    if (href.includes('/api/dsh-trivium/turn')) return response(200, { ok: true, sessions: [] });
    if (href.includes('/api/dsh-trivium/corrections')) return response(200, { ok: true, sessions: [] });
    if (href.includes('/api/dsh-trivium/embedding')) return response(200, { ok: true, calls: 0 });
    return response(200, { ok: true });
  };
  return { fetchImpl, calls, searches,reviews,pendingRows,historyRows,documents, text: () => liveText, setText: (next) => { liveText = next; } };
}

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
    useCallback(fn,deps) {
      const i = cursor++;
      const prior=hooks[i];
      if (!prior || !Array.isArray(deps) || !Array.isArray(prior.deps) || deps.length !== prior.deps.length || deps.some((value,j)=>!Object.is(value,prior.deps[j]))) hooks[i]={fn,deps};
      return hooks[i].fn;
    },
    useEffect(fn, deps) { effects.push({ index: cursor++, fn, deps }); },
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

const element = (type, props, key) => ({ type, props: props || {}, key });

function loadBundle(fetchImpl) {
  let registration = null;
  const listeners = new Map();
  const win = {
    __ModuleLoader__: { load(def) { registration = def; } },
    innerWidth: 0,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      listeners.set(name, (listeners.get(name) || []).filter((item) => item !== fn));
    },
    dispatch(name, event) {
      for (const fn of listeners.get(name) || []) fn(event);
    },
  };
  const sandbox = {
    window: win,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    console,
    URLSearchParams,
    TextDecoder,
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'lib/client.js' });
  if (!registration) throw new Error('bundle did not register');
  return { registration, win };
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function mount(options) {
  const server = createServer(options);
  const runtime = createRuntime();
  const table = {
    react: runtime.react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: function Button(props) { return element('button', props); },
    },
  };
  const { registration } = loadBundle(server.fetchImpl);
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

  let current = null;
  const render = () => {
    runtime.begin();
    current = component({});
    for (const effect of runtime.pending()) {
      if (runtime.depsUnchanged(effect.index, effect.deps)) continue;
      runtime.markDeps(effect.index, effect.deps);
      effect.fn();
    }
    return current;
  };
  render();
  for (let i = 0; i < 8; i += 1) {
    await settle();
    render();
  }
  return { render, tree: () => current, server };
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
const nodesOf = (tree) => walk(tree).nodes;

const pageTab = (tree, label) => {
  const strip = nodesOf(tree).find((n) => n.props && n.props.role === 'tablist');
  return walk(strip).nodes.find((n) => n.props && n.props.role === 'tab' && n.props.children === label);
};

const entityCard = (tree) => {
  const card = nodesOf(tree).find((n) => n.type === 'section' && textOf(n).startsWith('实体范围检索'));
  assert(!!card, 'the entity-search card is not rendered');
  return card;
};

const labeledControl = (card, label) => {
  const field = walk(card).nodes.find(
    (n) => n.type === 'label' && Array.isArray(n.props.children)
      && n.props.children[0] && n.props.children[0].props
      && n.props.children[0].props.children === label,
  );
  assert(!!field, `no field labelled ${label}`);
  return field.props.children[1];
};

const runButton = (card) => {
  // The run control is the host `Button` primitive: in a structural tree its node
  // type is the component, so the label is what identifies it.
  const button = walk(card).nodes.find(
    (n) => n.props && (n.props.children === '运行实体检索' || n.props.children === '检索中…'),
  );
  assert(!!button, 'the entity-search card has no run button');
  return button;
};

const searchCalls = (server) => server.calls.filter((call) => call.href.includes('/api/dsh-trivium/entity-search'));

function candidate(id, name, text, extra = {}) {
  return {
    id: String(id),
    type: 'decision',
    name,
    text,
    score: 0.71,
    scoreKind: 'lexical',
    review: '',
    path: { nodes: [String(id)], edges: [] },
    ...extra,
  };
}

function payload(over = {}) {
  return {
    source: 'live',
    timeBasis: 'query-time',
    asOf: '2026-11-16T10:00:00.000Z',
    cwd: ALPHA,
    entityId: '101',
    state: 'ok',
    answerability: 'not_assessed',
    scope: { name: 'Alpha 服务', eligibleCount: 3, rawCount: 4, complete: true },
    work: { examinedNodes: 4, examinedEdges: 3, cpuMs: 12, embeddingCalls: 0 },
    channels: {
      text: { status: 'ran', truncated: false, calls: 0 },
      semantic: { status: 'not_requested', calls: 0 },
    },
    textCandidates: [],
    semanticCandidates: [],
    warnings: [],
    degraded: false,
    ...over,
  };
}

const edit = (app, label, value) => {
  const control = labeledControl(entityCard(app.tree()), label);
  control.props.onChange({ target: { value } });
  return app.render();
};

/** Run one search: click, answer the pending request, then render the settled tree. */
async function runSearch(app, { status = 200, reply }) {
  const before = app.server.searches.length;
  const pending = runButton(entityCard(app.tree())).props.onClick();
  await settle(1);
  assert(app.server.searches.length === before + 1, 'the run button did not issue exactly one request');
  app.server.searches[before].reply(status, reply);
  await pending;
  await settle();
  return { tree: app.render(), request: app.server.searches[before] };
}

const openContext = (app) => {
  pageTab(app.tree(), '上下文').props.onClick();
  return app.render();
};

try {
  const app = await mount();
  openContext(app);

  await check(() => {
    const card = entityCard(app.tree());
    const text = textOf(card);
    assert(text.includes('实体范围检索'), 'card title missing');
    assert(text.includes('有候选不等于有答案'), 'the card does not warn that a neighbour is not an answer');
    assert(text.includes('填写实体 ID 或名称，再输入问题运行检索。'), 'the idle hint is missing');
    const box = walk(card).nodes.find((n) => n.props && n.props.type === 'checkbox');
    assert(box && box.props.checked === false, 'semantic must be off by default');
    assert(runButton(card).props.disabled === true, 'run must stay disabled without an entity id');
  }, 'the card opens idle with semantic off and the run button disabled');

  await check(async () => {
    edit(app, '实体节点 ID', '101');
    edit(app, '问题', '游标能复用多久？');
    const box = walk(entityCard(app.tree())).nodes.find((n) => n.props && n.props.type === 'checkbox');
    await check(() => assert(box.props.checked === false, 'semantic flipped on by itself'), 'semantic stays off while typing');
    const before = searchCalls(app.server).length;
    const pending = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    app.render();
    assert(runButton(entityCard(app.tree())).props.disabled === true, 'the run button stays enabled while busy');
    assert(textOf(entityCard(app.tree())).includes('检索中…'), 'the busy label is missing');
    const entry = app.server.searches.at(-1);
    assert(entry, 'no request was sent');
    assert(entry.cwd === ALPHA, `request bound to ${entry.cwd}`);
    assert(JSON.stringify(entry.body) === JSON.stringify({ entityId: 101, query: '游标能复用多久？', limit: 5, semantic: false }), `unexpected body ${JSON.stringify(entry.body)}`);
    entry.reply(200, payload({
      textCandidates: [candidate(201, '报告游标', '报告游标可以复用 24 小时。', {
        // The backend orients the path from the scope anchor to the candidate;
        // the card must echo whatever the endpoint sent, not re-orient it.
        path: { nodes: ['101', '201'], edges: [{ from: 101, to: 201, label: 'about' }] },
      })],
    }));
    await pending;
    await settle();
    app.render();
    assert(searchCalls(app.server).length === before + 1, 'a single run sent more than one request');
    assert(app.server.calls.every((call) => !call.href.includes('/embedding')), 'the panel called an embedding endpoint');
  }, 'a default search sends only endpoint fields to the current workspace and costs no embedding call');

  await check(() => {
    const text = textOf(entityCard(app.tree()));
    assert(text.includes('词面候选 · 1'), 'the lexical channel header is missing');
    assert(text.includes('语义候选 · 0'), 'the semantic channel is not listed separately');
    assert(text.includes('#201 · 报告游标'), 'the candidate row is missing');
    assert(text.includes('报告游标可以复用 24 小时。'), 'the candidate body is missing');
    assert(text.includes('#101 —about→ #201'), 'the relationship path is missing');
    assert(text.includes('lexical'), 'the score scale is not named');
    assert(text.includes('分数 0.7100'), 'the score value is missing');
    assert(text.includes('未请求语义通道（默认）。'), 'the semantic-off note is missing');
    assert(text.includes('候选不是答案：answerability 固定为 not_assessed'), 'answerability is not shown');
    assert(text.includes('范围：Alpha 服务 · 可读 3 / 记录 4 条'), 'the scope line is missing');
    assert(text.includes('embedding 0 次'), 'the work line does not report zero embedding calls');
    assert(text.includes('这一路没有候选。'), 'the empty semantic channel is silent');
  }, 'candidates, path, scope, work and answerability are shown, channels stay separate');

  await check(async () => {
    const { tree } = await runSearch(app, {
      reply: payload({
        state: 'no_candidates',
        scope: { name: 'Alpha 服务', eligibleCount: 2, rawCount: 2, complete: true },
      }),
    });
    const text = textOf(entityCard(tree));
    assert(text.includes('本次范围内没有候选。'), 'the empty-scope note is missing');
    assert(text.includes('answerability 固定为 not_assessed'), 'an empty result dropped the answerability line');
    assert(!text.includes('检索未完成'), 'an empty scope was reported as a failure');
    assert(text.includes('词面候选 · 0') && text.includes('语义候选 · 0'), 'both channels should be empty');
  }, 'a no_candidates result is explained, not shown as a found answer');

  await check(async () => {
    const box = walk(entityCard(app.tree())).nodes.find((n) => n.props && n.props.type === 'checkbox');
    box.props.onChange({ target: { checked: true } });
    app.render();
    const { tree, request } = await runSearch(app, {
      reply: payload({
        state: 'scope_anchor_only',
        scope: { name: 'Alpha 服务', eligibleCount: 1, rawCount: 1, complete: true },
        channels: { text: { status: 'ran', truncated: false, calls: 0 }, semantic: { status: 'skipped', calls: 0 } },
      }),
    });
    assert(request.body.semantic === true, 'the opt-in did not reach the request body');
    const text = textOf(entityCard(tree));
    assert(text.includes('这个实体在记录里没有业务关系，范围只有它自己。'), 'the anchor-only note is missing');
    assert(text.includes('范围只有实体自身，语义通道已跳过。'), 'the skipped semantic channel is not explained');
    box.props.onChange({ target: { checked: false } });
    app.render();
  }, 'an anchor-only scope explains that the semantic channel was skipped');

  await check(async () => {
    const { tree, request } = await runSearch(app, {
      reply: payload({ degraded: true, channels: { text: { status: 'ran', truncated: false, calls: 0 }, semantic: { status: 'disabled', calls: 0 } }, textCandidates: [candidate(201, '报告游标', '旧正文')] }),
    });
    assert(request.body.semantic === false, 'semantic was still requested');
    const text = textOf(entityCard(tree));
    assert(text.includes('语义通道不可用（disabled），已保留同范围词面结果。'), 'the degraded note is missing');
    assert(text.includes('#201 · 报告游标'), 'the lexical candidates were dropped on degradation');
  }, 'a degraded semantic channel keeps the same-scope lexical result and names the reason');

  /* --- workspace isolation and late replies --------------------------------- */
  await check(async () => {
    // Fill entity 101 in alpha and start a search that will answer after the switch.
    edit(app, '实体节点 ID', '101');
    edit(app, '问题', 'alpha 私有问题');
    const pending = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const alphaRequest = app.server.searches.at(-1);
    assert(alphaRequest.cwd === ALPHA, `alpha request bound to ${alphaRequest.cwd}`);
    app.render();
    assert(textOf(entityCard(app.tree())).includes('检索中…'), 'alpha search did not start');

    // Switch to beta while the alpha reply is still outstanding.
    const picker = nodesOf(app.tree()).find((n) => n.props && n.props['aria-label'] === '选择已知工作区');
    assert(!!picker, 'the workspace picker is missing');
    picker.props.onChange({ target: { value: BETA } });
    for (let i = 0; i < 6; i += 1) { await settle(2); app.render(); }
    const switched = app.render();
    const pickerNow = nodesOf(switched).find((n) => n.props && n.props['aria-label'] === '选择已知工作区');
    assert(pickerNow.props.value === BETA, `the picker still shows ${pickerNow.props.value}`);
    const card = entityCard(switched);
    assert(labeledControl(card, '实体节点 ID').props.value === '', 'the old entity id survived the switch');
    assert(labeledControl(card, '问题').props.value === '', 'the old question survived the switch');
    assert(textOf(card).includes('填写实体 ID 或名称，再输入问题运行检索。'), 'the card kept a stale result or error');

    // Beta's own search starts before alpha's reply arrives, so the two responses
    // really are interleaved: the beta request is newer, not merely different.
    edit(app, '实体节点 ID', '202');
    edit(app, '问题', 'beta 问题');
    const betaPending = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const betaRequest = app.server.searches.at(-1);
    assert(betaRequest.cwd === BETA, `beta request bound to ${betaRequest.cwd}`);

    // The late alpha reply arrives now: it must not touch the beta panel.
    alphaRequest.reply(200, payload({ cwd: ALPHA, textCandidates: [candidate(201, 'ALPHA-ONLY', 'alpha 私有事实，不应出现在 beta')] }));
    await pending;
    await settle(4);
    const after = app.render();
    const late = textOf(entityCard(after));
    assert(!late.includes('ALPHA-ONLY'), 'a late alpha candidate landed in the beta panel');
    assert(!late.includes('alpha 私有事实'), 'a late alpha body landed in the beta panel');
    assert(!textOf(after).includes('ALPHA-ONLY'), 'a late alpha candidate leaked onto the page');
    assert(!nodesOf(after).some((n) => n.props && n.props.role === 'alert'), 'the late alpha reply produced an alert');
    assert(late.includes('检索中…'), 'the beta search was cancelled by the late alpha reply');

    betaRequest.reply(200, payload({ cwd: BETA, entityId: '202', scope: { name: 'Beta 服务', eligibleCount: 1, rawCount: 1, complete: true }, textCandidates: [candidate(301, 'BETA-ONLY', 'beta 的合成事实')] }));
    await betaPending;
    await settle();
    const betaText = textOf(entityCard(app.render()));
    assert(betaText.includes('BETA-ONLY'), 'the beta result is missing');
    assert(!betaText.includes('ALPHA-ONLY'), 'the alpha result came back in beta');
  }, 'switching workspaces clears the old input/result and a late reply cannot land in the new one');

  await check(async () => {
    // A -> B -> A: the cwd string matches again, but the stale reply stays stale
    // because switching cleared the inputs and invalidated the request sequence.
    // Only the sequence guard can reject this one, so the cwd check cannot hide a
    // regression here.
    const pickerTo = (value) => {
      const picker = nodesOf(app.tree()).find((n) => n.props && n.props['aria-label'] === '选择已知工作区');
      picker.props.onChange({ target: { value } });
    };
    pickerTo(ALPHA);
    for (let i = 0; i < 6; i += 1) { await settle(2); app.render(); }
    assert(nodesOf(app.tree()).find((n) => n.props && n.props['aria-label'] === '选择已知工作区').props.value === ALPHA, 'alpha did not load');
    edit(app, '实体节点 ID', '101');
    edit(app, '问题', '离开前的问题');
    const stale = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const staleRequest = app.server.searches.at(-1);
    assert(staleRequest.cwd === ALPHA, `stale request bound to ${staleRequest.cwd}`);
    pickerTo(BETA);
    for (let i = 0; i < 6; i += 1) { await settle(2); app.render(); }
    pickerTo(ALPHA);
    for (let i = 0; i < 6; i += 1) { await settle(2); app.render(); }
    const back = nodesOf(app.render()).find((n) => n.props && n.props['aria-label'] === '选择已知工作区');
    assert(back.props.value === ALPHA, `the picker did not return to alpha (${back.props.value})`);
    // Same library, same entity id: only the sequence guard can reject this reply.
    staleRequest.reply(200, payload({ cwd: ALPHA, entityId: '101', textCandidates: [candidate(306, 'STALE-AFTER-RETURN', '返回后不应出现的旧结果')] }));
    await stale.catch(() => {});
    await settle(4);
    const text = textOf(entityCard(app.render()));
    assert(!text.includes('STALE-AFTER-RETURN'), 'a reply from before the round trip resurrected');
    assert(text.includes('填写实体 ID 或名称，再输入问题运行检索。'), 'the card is not idle after the round trip');
  }, 'a reply started before an A->B->A round trip is still rejected on return');

  await check(async () => {
    // Slow #1, then a newer #2; answer #2 first and #1 last (inverted completion).
    edit(app, '实体节点 ID', '202');
    edit(app, '问题', '慢请求');
    const slow = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const slowRequest = app.server.searches.at(-1);
    // Editing the question is the documented way to invalidate the in-flight result.
    edit(app, '问题', '快请求');
    edit(app, '问题', '快请求');
    const fast = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const fastRequest = app.server.searches.at(-1);
    assert(fastRequest !== slowRequest, 'the second run did not reach the server');
    assert(fastRequest.body.query === '快请求', `second body query ${fastRequest.body.query}`);
    fastRequest.reply(200, payload({ cwd: BETA, textCandidates: [candidate(302, 'FAST-RESULT', '较新的结果')] }));
    await fast;
    await settle();
    const afterFast = textOf(entityCard(app.render()));
    assert(afterFast.includes('FAST-RESULT'), 'the newer result is missing');
    slowRequest.reply(200, payload({ cwd: BETA, textCandidates: [candidate(303, 'SLOW-RESULT', '较旧的迟到结果')] }));
    await slow.catch(() => {});
    await settle(4);
    const afterSlow = textOf(entityCard(app.render()));
    assert(!afterSlow.includes('SLOW-RESULT'), 'the older late reply overwrote the newer result');
    assert(afterSlow.includes('FAST-RESULT'), 'the newer result was replaced');
    assert(!afterSlow.includes('检索中…'), 'the card stayed busy after both replies settled');
  }, 'an older reply cannot overwrite a newer search in the same workspace');

  await check(async () => {
    // A late error must be dropped the same way a late success is.
    edit(app, '问题', '迟到错误');
    const slow = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const slowRequest = app.server.searches.at(-1);
    edit(app, '问题', '新的问题');
    edit(app, '问题', '新的问题');
    const fast = runButton(entityCard(app.tree())).props.onClick();
    await settle(1);
    const fastRequest = app.server.searches.at(-1);
    fastRequest.reply(200, payload({ cwd: BETA, textCandidates: [candidate(304, 'NEWEST', '最新结果')] }));
    await fast;
    await settle();
    slowRequest.reply(409, { ok: false, code: 'ENTITY_SEARCH_SCOPE_CHANGED', message: 'changed' });
    await slow.catch(() => {});
    await settle(4);
    const tree = app.render();
    const text = textOf(entityCard(tree));
    assert(!text.includes('相关正文、关系、库句柄或 embedding 配置发生变化'), 'a late error was displayed');
    assert(!nodesOf(tree).some((n) => n.props && n.props.role === 'alert'), 'a late error produced an alert');
    assert(text.includes('NEWEST'), 'the newest result was lost');
  }, 'a late error is dropped instead of replacing a newer result');

  /* --- source isolation ----------------------------------------------------- */
  await check(async () => {
    edit(app, '问题', '游标');
    edit(app, '实体节点 ID', '202');
    const sourceSelect = labeledControl(entityCard(app.tree()), '数据来源');
    sourceSelect.props.onChange({ target: { value: 'snapshot' } });
    app.render();
    const card = entityCard(app.tree());
    const snapshotInput = labeledControl(card, '快照 ID（留空选最新）');
    assert(!!snapshotInput, 'the snapshot id field did not appear');
    assert(textOf(card).includes('留空选最新快照'), 'the snapshot hint is missing');

    const { tree, request } = await runSearch(app, {
      reply: payload({
        source: 'snapshot',
        timeBasis: 'snapshot-capture',
        asOf: '2026-11-14T08:00:00.000Z',
        snapshotId: 'snap-alpha-1',
        cwd: BETA,
        scope: { name: 'Beta 服务', eligibleCount: 1, rawCount: 1, complete: true },
        textCandidates: [candidate(301, '捕获时正文', '快照保留捕获时的旧正文')],
      }),
    });
    assert(request.body.snapshotId === 'latest', `snapshot body carried ${JSON.stringify(request.body.snapshotId)}`);
    const text = textOf(entityCard(tree));
    assert(text.includes('snapshot · Beta 服务'), 'the snapshot source is not shown');
    assert(text.includes('快照时间（有效期按此时判断） · 2026-11-14T08:00:00.000Z'), 'the captured time is not shown');
    assert(text.includes('snap-alpha-1'), 'the snapshot id is not echoed');
    assert(text.includes('快照保留捕获时的旧正文'), 'the captured body is missing');
  }, 'a fixed snapshot request carries the snapshot and shows the captured time');

  await check(async () => {
    const before = searchCalls(app.server).length;
    const { tree } = await runSearch(app, {
      status: 404,
      reply: { ok: false, code: 'SNAPSHOT_NOT_FOUND', message: 'No snapshot snap-missing.' },
    });
    const card = entityCard(tree);
    assert(textOf(card).includes('还没有可用快照，请先创建。'), 'a missing snapshot is not explained');
    assert(nodesOf(card).some((n) => n.props && n.props.role === 'alert'), 'a missing snapshot has no alert');
    assert(searchCalls(app.server).length === before + 1, 'the panel retried or fell back to live');
    assert(!textOf(card).includes('词面候选 ·'), 'a missing snapshot still rendered candidates');
  }, 'a missing snapshot fails clearly and does not silently fall back to live');

  await check(async () => {
    // Back to live: the same question must not inherit the snapshot answer.
    const sourceSelect = labeledControl(entityCard(app.tree()), '数据来源');
    sourceSelect.props.onChange({ target: { value: 'live' } });
    app.render();
    assert(labeledControl(entityCard(app.tree()), '数据来源').props.value === 'live', 'the source did not switch back');
    assert(!textOf(entityCard(app.tree())).includes('还没有可用快照'), 'the snapshot error survived the source change');
    const { tree, request } = await runSearch(app, {
      reply: payload({ cwd: BETA, textCandidates: [candidate(305, 'LIVE-正文', '编辑后的新正文')] }),
    });
    assert(!('snapshotId' in request.body), 'a live request still carried a snapshot id');
    const text = textOf(entityCard(tree));
    assert(text.includes('编辑后的新正文'), 'the live body is missing');
    assert(!text.includes('快照保留捕获时的旧正文'), 'the snapshot body leaked into live');
  }, 'switching back to live clears the snapshot result and sends no snapshot id');

  await check(async () => {
    const named = await mount();
    openContext(named);
    edit(named, '实体节点 ID', '101');
    edit(named, '实体名称或别名', '报告中继');
    edit(named, '问题', '游标能复用多久？');
    const choice = await runSearch(named, {status: 409, reply: {ok:false, code:'ENTITY_SEARCH_NAME_AMBIGUOUS', choiceCount:2,
      choices:[{id:101, name:'Alpha 中继'},{id:301, name:'备用中继'}]}});
    assert(choice.request.body.entityName === '报告中继' && !('entityId' in choice.request.body), 'name was sent with an ID');
    assert(choice.request.body.semantic === false, 'the name lookup opted into embedding');
    const candidates = entityCard(choice.tree);
    assert(textOf(candidates).includes('名称匹配多个实体'), 'the ambiguity is missing');
    const pick = nodesOf(candidates).find(node => node.props?.children === '#101 · Alpha 中继');
    assert(!!pick, 'the matching entity is not selectable');
    pick.props.onClick();
    named.render();
    assert(named.server.searches.length === 1, 'selecting a choice automatically searched');
    const {request} = await runSearch(named, {reply:payload()});
    assert(request.body.entityId === 101 && !('entityName' in request.body), 'the retry did not use the selected ID');

    edit(named, '实体名称或别名', '仅在 Alpha 的别名');
    const pending = runButton(entityCard(named.tree())).props.onClick();
    await settle();
    const stale = named.server.searches.at(-1);
    const workspace = nodesOf(named.render()).find(node => node.type === 'select' && node.props.value === ALPHA);
    workspace.props.onChange({target:{value:BETA}});
    for (let i=0;i<6;i++) {await settle(); named.render();}
    stale.reply(409, {ok:false, code:'ENTITY_SEARCH_NAME_AMBIGUOUS', choiceCount:2, choices:[{id:404,name:'旧库候选'}]});
    await pending;
    const switched = entityCard(named.render());
    assert(labeledControl(switched,'实体名称或别名').props.value === '', 'the name followed the request to another library');
    assert(!textOf(switched).includes('旧库候选'), 'the old response offered choices in another workspace');
  }, 'the name entry resolves through explicit choices and drops late choices from another workspace');

  /* --- error matrix --------------------------------------------------------- */
  const errorCases = [
    { status: 400, code: 'ENTITY_SEARCH_INVALID', expect: '请填写有效的实体 ID 或名称、非空问题和每路条数（1–20）。' },
    { status: 404, code: 'ENTITY_SEARCH_ENTITY_NOT_FOUND', expect: '这个实体 ID 不存在。' },
    { status: 409, code: 'ENTITY_SEARCH_SCOPE_CHANGED', expect: '检索期间相关正文、关系、库句柄或 embedding 配置发生变化，请重试。不会自动重试。' },
    { status: 422, code: 'ENTITY_SEARCH_WORK_LIMIT', expect: '检索超出共享工作预算，没有返回部分候选。请减少条数或换一个实体。' },
    { status: 429, code: 'READ_BUSY', expect: '读取通道正忙（全局最多两个只读请求），请稍后重试。' },
    { status: 408, code: 'ENTITY_SEARCH_TIMEOUT', expect: '检索超时或已取消，没有返回部分候选。' },
  ];
  for (const item of errorCases) {
    await check(async () => {
      const before = searchCalls(app.server).length;
      const { tree } = await runSearch(app, { status: item.status, reply: { ok: false, code: item.code, message: 'controlled failure' } });
      const card = entityCard(tree);
      const alert = nodesOf(card).find((n) => n.props && n.props.role === 'alert');
      assert(!!alert, `no alert for ${item.code}`);
      const text = textOf(alert);
      assert(text.includes(item.expect), `${item.code} shows ${JSON.stringify(text)}`);
      assert(text.includes(String(item.status)) && text.includes(item.code), `${item.code} does not echo status and code`);
      assert(text.includes('实体范围检索') === false, 'the alert swallowed the card');
      assert(!textOf(card).includes('词面候选 ·'), 'a failed search rendered candidates');
      assert(searchCalls(app.server).length === before + 1, `${item.code} triggered a retry`);
      const runnable = runButton(card);
      assert(runnable.props.disabled === false, `the run button stayed disabled after ${item.code}`);
    }, `${item.status} ${item.code} renders one distinct state without retrying`);
  }

  await check(async () => {
    // Invalid input never leaves the panel: no request, and the reason is on the title.
    edit(app, '实体节点 ID', '');
    const card = entityCard(app.tree());
    const button = runButton(card);
    assert(button.props.disabled === true, 'an empty entity id can still be submitted');
    assert(button.props.title === '请填写有效的实体 ID 或名称、非空问题和每路条数（1–20）。', 'the invalid-input title is missing');
    const before = searchCalls(app.server).length;
    edit(app, '实体节点 ID', '0');
    assert(runButton(entityCard(app.tree())).props.disabled === true, 'entity id 0 can still be submitted');
    edit(app, '实体节点 ID', '101');
    edit(app, '每路最多条数（1–20）', '21');
    assert(runButton(entityCard(app.tree())).props.disabled === true, 'limit 21 can still be submitted');
    edit(app, '每路最多条数（1–20）', '5');
    assert(searchCalls(app.server).length === before, 'an invalid form still reached the server');
  }, 'invalid input is blocked before any request is sent');

  await check(async () => {
    edit(app, '记忆包预算（估算 token，0 关闭）', '300');
    const { tree, request } = await runSearch(app, { reply: payload({ cwd: BETA,
      warnings: [{ code: 'MULTIPLE_CURRENT_FACTS', name: '留存期', ids: ['201', '202'] }],
      memoryPack: { estimatedTokens: 190, budgetTokens: 300,
        context: 'UNRESOLVED 留存期: #201, #202\n#201 不允许写入，保留 30 天。\n#202 不允许写入，保留 90 天。', omittedIds: ['203'] },
    }) });
    assert(request.body.packTokens === 300 && request.body.semantic === false, 'pack opt-in changed semantic or lost budget');
    const text = textOf(entityCard(tree));
    assert(text.includes('任务相关记忆包 · 190 / 300'), 'pack accounting is hidden');
    assert(text.includes('#201 不允许写入，保留 30 天。') && text.includes('#202 不允许写入，保留 90 天。'), 'one side or a negation was lost');
    assert(text.includes('留存期') && text.includes('需核对'), 'ambiguity warning is hidden');
    assert(text.includes('ctx_read: #203') && text.includes('不代表实际账单'), 'omission or estimated-token boundary is hidden');
  }, 'an explicit pack budget renders whole alternatives, ambiguity and omitted ids without embedding');

  await check(async () => {
    const before = searchCalls(app.server).length;
    for (const value of ['-1', '0.5', '2001', 'NaN']) {
      edit(app, '记忆包预算（估算 token，0 关闭）', value);
      const button = runButton(entityCard(app.tree()));
      assert(button.props.disabled === true, 'invalid pack budget enabled run');
      await button.props.onClick();
    }
    assert(searchCalls(app.server).length === before, 'invalid budget reached server');
    edit(app, '记忆包预算（估算 token，0 关闭）', '0');
    const { request } = await runSearch(app, { reply: payload({ cwd: BETA }) });
    assert(!('packTokens' in request.body), 'disabled pack changed the default request');
  }, 'invalid pack budgets cannot submit and zero keeps the original endpoint shape');

  await check(async () => {
    edit(app, '记忆包预算（估算 token，0 关闭）', '300');
    const picker = nodesOf(app.tree()).find(n => n.props?.['aria-label'] === '选择已知工作区');
    picker.props.onChange({ target: { value: picker.props.value === ALPHA ? BETA : ALPHA } });
    for (let i = 0; i < 6; i++) { await settle(2); app.render(); }
    assert(labeledControl(entityCard(app.tree()), '记忆包预算（估算 token，0 关闭）').props.value === '0', 'workspace switch retained pack opt-in');
    assert(!textOf(entityCard(app.tree())).includes('UNRESOLVED'), 'previous workspace pack survived');
  }, 'workspace changes reset pack opt-in and clear previous packed facts');
} catch (err) {
  failures += 1;
  console.error('FAIL unexpected throw: ' + (err && err.stack ? err.stack : err));
}

try {
  const reviewApp=await mount({withPending:true});
  const button=(label)=>nodesOf(reviewApp.tree()).find(n=>n.props?.children===label && n.props?.onClick);
  const refresh=async()=>{for(let i=0;i<5;i++){await settle(2);reviewApp.render();}};
  pageTab(reviewApp.tree(),'运行记录').props.onClick();reviewApp.render();await refresh();
  await check(()=>{
    assert(textOf(reviewApp.tree()).includes('格式是什么？'),'source excerpt is absent');
    assert(button('补充依据并核对').props.disabled,'empty supplement can submit');
    assert(!!button('确认记住'),'manual review action missing');
  },'pending review exposes actual source and requires evidence before checking');
  await check(async()=>{
    const field=nodesOf(reviewApp.tree()).find(n=>n.props?.['aria-label']==='补充依据（不调用模型）');
    field.props.onChange({target:{value:'尚未确定。'}});reviewApp.render();
    const pending=button('补充依据并核对').props.onClick();reviewApp.render();
    const req=reviewApp.server.reviews.at(-1);assert(req.body.evidence==='尚未确定。' && req.body.action==='verify','supplement payload missing');
    assert(cwdOf(req.href)===ALPHA,'explicit scope missing');
    req.reply(200,{ok:true,settled:false});await pending;await refresh();
    assert(textOf(reviewApp.tree()).includes('已保留待核对'),'unsupported evidence looked like success');
    assert(!!button('确认记住'),'unsupported evidence lost candidate');
  },'unverified evidence leaves the candidate available and reports the result');
  await check(async()=>{
    const before=reviewApp.server.reviews.length;
    const pending=button('确认记住').props.onClick();reviewApp.render();
    assert(textOf(reviewApp.tree()).includes('不会替换、合并或删除旧记忆'),'manual confirmation boundary missing');
    assert(reviewApp.server.reviews.length===before,'confirmation wrote before explicit acceptance');
    button('取消').props.onClick();await pending;await refresh();
    assert(reviewApp.server.reviews.length===before,'cancel wrote a memory');
  },'manual confirmation requires deliberate acceptance and cancel performs no write');
  await check(async()=>{
    const before=reviewApp.server.reviews.length;
    const pending=button('确认记住').props.onClick();reviewApp.render();
    const picker=nodesOf(reviewApp.tree()).find(n=>n.props?.['aria-label']==='选择已知工作区');
    picker.props.onChange({target:{value:BETA}});reviewApp.render();await pending;await refresh();
    assert(reviewApp.server.reviews.length===before,'workspace switch submitted the old confirmation');
    assert(!textOf(reviewApp.tree()).includes(ALPHA+' 格式是 XLSX。'),'old candidate remains in B');
  },'workspace switch cancels an open confirmation and clears the old candidate');
  await check(async()=>{
    const pending=button('确认记住').props.onClick();reviewApp.render();
    const accept=nodesOf(reviewApp.tree()).filter(n=>n.props?.children==='确认记住' && n.props?.onClick).at(-1);
    accept.props.onClick();await settle();reviewApp.render();
    const req=reviewApp.server.reviews.at(-1);assert(cwdOf(req.href)===BETA && req.body.etag==='2'.repeat(64),'manual request uses stale source');
    req.reply(409,{ok:false,message:'This source window changed.'});await pending;await refresh();
    assert(textOf(reviewApp.tree()).includes('This source window changed.'),'stale response is hidden');
    assert(!!button('确认记住'),'stale response lost pending candidate');
  },'stale review is shown as a failure and leaves the candidate for refresh');
  await check(async()=>{
    const pending=button('确认记住').props.onClick();reviewApp.render();
    nodesOf(reviewApp.tree()).filter(n=>n.props?.children==='确认记住' && n.props?.onClick).at(-1).props.onClick();
    await settle();reviewApp.render();const req=reviewApp.server.reviews.at(-1);
    const picker=nodesOf(reviewApp.tree()).find(n=>n.props?.['aria-label']==='选择已知工作区');
    picker.props.onChange({target:{value:ALPHA}});reviewApp.render();await refresh();
    req.reply(200,{ok:true,settled:true,nodeId:99});await pending;await refresh();
    assert(!textOf(reviewApp.tree()).includes('已保存为手动确认的记忆'),'late B success appeared in A');
    assert(textOf(reviewApp.tree()).includes(ALPHA+' 格式是 XLSX。'),'late B success cleared A');
  },'late review success cannot overwrite the selected workspace or clear its candidate');
}catch(err){failures++;console.error('FAIL review UI: '+err.stack);}

try {
  const next=await mount({withPending:true});
  const refresh=async()=>{for(let i=0;i<6;i++){await settle();next.render();}};
  const button=label=>nodesOf(next.tree()).find(n=>n.props?.children===label&&typeof n.props?.onClick==='function');
  await check(async()=>{
    pageTab(next.tree(),'运行记录').props.onClick();await refresh();
    assert(!!button('不采纳，保留记录'),'dismiss action is not rendered');
    const pending=button('不采纳，保留记录').props.onClick();await settle();next.render();
    const req=next.server.reviews.at(-1);assert(req.body.action==='dismiss','dismissal is not explicit');assert(cwdOf(req.href)===ALPHA,'dismissal lost its workspace');
    next.server.pendingRows[ALPHA]=[];
    next.server.historyRows[ALPHA]=Array.from({length:23},(_,i)=>({action:'dismiss',at:'2026-11-17',candidateId:String(i),candidate:{type:'decision',name:'记录',text:'保留原文 '+i},sourceTurns:[{role:'user',text:'来源 '+i}]}));
    req.reply(200,{ok:true,settled:true,action:'dismiss',nodeId:null});await pending;await refresh();
    assert(textOf(next.tree()).includes('原文、来源和回执')||textOf(next.tree()).includes('原文'), 'dismissal history is missing');
    assert(textOf(next.tree()).includes('保留原文 0'),'history is hidden when pending is empty');
    await button('下一页').props.onClick();await refresh();assert(textOf(next.tree()).includes('保留原文 22'),'history pagination did not load');
    assert(!textOf(next.tree()).includes('保留原文 0'),'history pagination mixed pages');
  },'dismiss UI retains readable history even with no pending windows, including pagination');
  await check(async()=>{
    const picker=nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='工作区');
    const actual=picker||nodesOf(next.tree()).find(n=>n.type==='select'&&n.props?.value===ALPHA);
    actual.props.onChange({target:{value:BETA}});await refresh();assert(!textOf(next.tree()).includes('保留原文 22'),'history crossed workspace');
  },'review history is cleared by workspace switch');
  await check(async()=>{
    pageTab(next.tree(),'上下文').props.onClick();await refresh();
    const source=nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='来源标识，例如 docs/config.md');source.props.onChange({target:{value:'docs/example.md'}});next.render();
    nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='文档原文').props.onChange({target:{value:'明确的原文。'}});next.render();
    const pending=button('保存来源版本').props.onClick();await settle();next.render();const req=next.server.documents.at(-1);
    assert(req.body.action==='save'&&req.body.sourceId==='docs/example.md','document save schema is wrong');assert(cwdOf(req.href)===BETA,'document save escaped workspace');
    const picker=nodesOf(next.tree()).find(n=>n.type==='select'&&n.props?.value===BETA);picker.props.onChange({target:{value:ALPHA}});await refresh();
    req.reply(200,{ok:true,document:{document_id:'99',revision:'old-B',content:'B 原文'}});await pending;await refresh();
    const input=nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='文档原文');assert(input.props.value==='','late document save restored another scope');
    assert(button('关联依据').props.disabled,'old document remains linkable');
  },'document import is explicit and a late save cannot restore another workspace source');
  await check(async()=>{
    const pending=button('读取来源与关联').props.onClick();await settle();next.render();const req=next.server.documents.at(-1);
    req.reply(200,{ok:true,documents:[],document:null,links:[{evidenceId:4,factId:2,sourceId:'docs/old.md',status:'source_changed',needsReview:true,quote:'旧证据',
      comparison:{previous:{text:'旧证据'},current:{text:'现行相邻文本',start:{line:3,column:2},match:'near-previous-byte'}}}]});await pending;await refresh();
    assert(textOf(next.tree()).includes('需要复核')&&textOf(next.tree()).includes('旧证据'),'changed source is not reviewable');
    assert(textOf(next.tree()).includes('现行相邻文本')&&textOf(next.tree()).includes('不一定对应'),'revision comparison overstates the nearby excerpt');
    assert(!next.server.documents.some(r=>r.body?.action==='delete'),'document review unexpectedly deletes facts');
  },'changed document evidence displays review status and retained original excerpt');
  await check(async()=>{
    const load=button('读取来源与关联').props.onClick();await settle();next.render();
    next.server.documents.at(-1).reply(200,{ok:true,documents:[],document:{document_id:'101',source_id:'docs/revisions.md',revision:'rev-1',content:'旧依据'},links:[]});await load;await refresh();
    nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='已有记忆 ID').props.onChange({target:{value:'2'}});next.render();
    nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='依据片段（须在原文中唯一出现）').props.onChange({target:{value:'旧依据'}});next.render();
    assert(!button('关联依据').props.disabled,'saved source cannot be linked');
    nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='文档原文').props.onChange({target:{value:'新依据'}});next.render();
    assert(button('关联依据').props.disabled&&textOf(next.tree()).includes('先保存来源版本'),'unsaved source can be mistaken for a persisted revision');
    const save=button('保存来源版本').props.onClick();await settle();next.render();const req=next.server.documents.at(-1);
    assert(req.body.expectedRevision==='rev-1'&&req.body.documentId===101,'source update lost its revision guard');
    req.reply(200,{ok:true,document:{document_id:'101',source_id:'docs/revisions.md',revision:'rev-2',content:'新依据'},review:{links:[{evidenceId:5,factId:2,sourceId:'docs/revisions.md',status:'source_changed',needsReview:true,quote:'旧依据'}]}});
    await save;await refresh();assert(textOf(next.tree()).includes('来源已更新')&&textOf(next.tree()).includes('旧依据'),'save did not refresh affected evidence');
  },'edited sources must be saved before linking and saving refreshes review warnings');
  await check(async()=>{
    const field=label=>nodesOf(next.tree()).find(n=>n.props?.['aria-label']===label);
    const pick=async (name,bytes)=>{
      await field('选择 Markdown 或文本文件').props.onChange({target:{files:[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}],value:name}});
      await refresh();
    };
    const before=next.server.documents.length;
    await pick('notes.md',new Uint8Array([0xff]));
    assert(textOf(next.tree()).includes('有效 UTF-8'),'invalid UTF-8 was accepted');
    const raw='# 选中文件\r\n冷却期 19 分钟。\r\n';
    await pick('notes.md',new TextEncoder().encode(raw));
    assert(field('文档原文').props.value===raw,'the picker did not retain the original text');
    assert(field('来源标识，例如 docs/config.md').props.value==='notes.md'&&next.server.documents.length===before,'choosing a file wrote before saving');
    const save=button('保存来源版本').props.onClick();await settle();next.render();
    const request=next.server.documents.at(-1);assert(request.body.content===raw&&request.body.sourceId==='notes.md','disk source was not passed verbatim');
    request.reply(200,{ok:true,document:{document_id:'120',source_id:'notes.md',revision:'notes-rev',content:raw},review:{links:[]}});await save;await refresh();
    field('在此来源中找片段').props.onChange({target:{value:'冷却期'}});next.render();
    const search=button('检索片段').props.onClick();await settle();next.render();
    const query=next.server.documents.at(-1),params=new URL(query.href,'http://local/').searchParams;
    assert(params.get('documentId')==='120'&&params.get('revision')==='notes-rev'&&params.get('query')==='冷却期','fragment query is unscoped');
    const reference={document_id:'120',revision:'notes-rev',start_byte:16,end_byte:39};
    query.reply(200,{ok:true,context:'notes.md:2\n冷却期 19 分钟。',fragments:[{text:'冷却期 19 分钟。',start:{line:2,column:1},reference}]});await search;await refresh();
    button('使用这段原文').props.onClick();next.render();
    assert(field('可复制的证据片段').props.value.includes('notes.md:2'),'fragment context cannot be copied');
    const attach=button('关联依据').props.onClick();await settle();next.render();const link=next.server.documents.at(-1);
    assert(link.body.reference.start_byte===16&&link.body.quote==='冷却期 19 分钟。','link lost the selected byte range');
    link.reply(200,{ok:true,review:{links:[]}});await attach;await refresh();
  },'the explicit file picker, fragment query and byte range link work together without network reads on selection');
  await check(async()=>{
    let finish;
    const file=nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='选择 Markdown 或文本文件');
    const slow=file.props.onChange({target:{files:[{name:'late.md',size:9,arrayBuffer:()=>new Promise(resolve=>{finish=resolve;})}],value:'late.md'}});
    next.render();const picker=nodesOf(next.tree()).find(n=>n.type==='select'&&n.props?.value===ALPHA);picker.props.onChange({target:{value:BETA}});await refresh();
    finish(new TextEncoder().encode('late text').buffer);await slow;await refresh();
    assert(nodesOf(next.tree()).find(n=>n.props?.['aria-label']==='文档原文').props.value==='','late file content crossed into the selected workspace');
  },'a slow local file selection cannot cross a workspace boundary');
  await check(async () => {
    const broken = await mount({damagedCwd: ALPHA});
    assert(textOf(broken.tree()).includes('这个工作区的记忆库已损坏'));
    assert(nodesOf(broken.tree()).some(node => node.props?.role === 'alert' && node.props.title === 'Synthetic damaged TDB header'));
    assert(!broken.server.calls.some(call => call.href.includes('/api/dsh-trivium/nodes')));
    const picker = nodesOf(broken.tree()).find(node => node.type === 'select' && node.props.value === ALPHA);
    picker.props.onChange({target: {value: BETA}});
    for (let i = 0; i < 6; i++) { await settle(); broken.render(); }
    assert(!textOf(broken.tree()).includes('这个工作区的记忆库已损坏'));
    assert(textOf(broken.tree()).includes('Beta 的合成事实。'));
  }, 'a damaged library shows a scoped alert and leaves the healthy workspace switch usable');
  await check(async () => {
    pageTab(next.tree(), '上下文').props.onClick();
    await refresh();
    const load = button('读取来源与关联').props.onClick();
    await settle();
    next.server.documents.at(-1).reply(200, {ok: true, document: null, documents: [{documentId:'20',sourceId:'first-source.md'}], nextDocumentAfter:20,
      links: [{evidenceId:30,factId:2,sourceId:'first-source.md',quote:'First-page link'}], nextEvidenceAfter:30});
    await load;
    await refresh();
    const nextSource = button('下一页来源').props.onClick();
    await settle();
    const sourceRequest = next.server.documents.at(-1);
    const sourceParams = new URL(sourceRequest.href, 'http://local.invalid').searchParams;
    assert(sourceParams.get('documentAfter') === '20', 'the source request lost its cursor');
    assert(sourceParams.get('cwd') === BETA, 'the source request lost its workspace');
    assert(!sourceParams.has('evidenceAfter'));
    sourceRequest.reply(200, {ok:true,document:null,documents:[{documentId:'40',sourceId:'second-source.md'}],nextDocumentAfter:null});
    await nextSource;
    await refresh();
    assert(textOf(next.tree()).includes('second-source.md'));
    assert(textOf(next.tree()).includes('First-page link'));
    assert(!button('下一页来源'));
    const nextLink = button('下一页关联').props.onClick();
    await settle();
    const linkRequest = next.server.documents.at(-1);
    const linkParams = new URL(linkRequest.href, 'http://local.invalid').searchParams;
    assert(linkParams.get('evidenceAfter') === '30', 'the link request lost its cursor');
    assert(linkParams.get('cwd') === BETA, 'the link request lost its workspace');
    assert(!linkParams.has('documentAfter'));
    linkRequest.reply(200, {ok:true,links:[{evidenceId:41,factId:2,sourceId:'second-source.md',quote:'Second-page link'}],nextEvidenceAfter:41});
    await nextLink;
    await refresh();
    assert(textOf(next.tree()).includes('Second-page link'));
    assert(!textOf(next.tree()).includes('First-page link'));
    const fact = nodesOf(next.tree()).find(node => node.props?.['aria-label'] === '已有记忆 ID');
    fact.props.onChange({target:{value:'2'}});
    await refresh();
    assert(!button('下一页关联'));
    assert(!textOf(next.tree()).includes('Second-page link'));
  }, 'document and link pages navigate separately and changing the fact clears old results');
}catch(err){failures++;console.error('FAIL next memory UI: '+err.stack);}

console.log(`P101: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
