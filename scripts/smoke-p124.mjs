/** p124: task checkpoints and source citation panels. VM harness adapted from p101. */
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
    pluginLocale: 'en',
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
  const calls = []; const tasks = [];
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
    if(href.includes('/api/dsh-trivium/task-changes'))return new Promise(resolve=>tasks.push({href,method:opts?.method||'GET',body:opts?.body?JSON.parse(opts.body):null,reply(status,payload){resolve(response(status,payload));}}));
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
  return { fetchImpl, calls, tasks, searches,reviews,pendingRows,historyRows,documents, text: () => liveText, setText: (next) => { liveText = next; } };
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
  loaded.__locale.setPluginLocalePref('en');

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


const card = (app,key) => nodesOf(app.tree()).find(n=>n.props?.['data-page-card']===key);
const sourceCard = app => nodesOf(card(app,'document-evidence')).find(n=>n.props?.['data-document-source-search']);
const button = (tree,label) => nodesOf(tree).find(n=>n.props?.children===label && typeof n.props?.onClick==='function');
const field = (tree,label) => nodesOf(tree).find(n=>n.props?.['aria-label']===label);
function same(actual,expected,why) {
  assert(JSON.stringify(actual)===JSON.stringify(expected), why+'\n'+JSON.stringify(actual)+' !== '+JSON.stringify(expected));
}
async function context() {
  const app = await mount();
  pageTab(app.tree(),'Context').props.onClick();
  app.render();
  return app;
}
async function answer(app,list,label,body,status=200) {
  const before=list.length;
  assert(label&&!label.props.disabled,'control disabled or absent');
  const running=label.props.onClick();
  await settle(1); app.render();
  assert(list.length===before+1,'not exactly one request');
  const request=list[before];
  request.reply(status,body);
  await running; await settle(); app.render();
  return request;
}
const peek = (cwd,name='ALPHA_CURRENT',extras={}) => ({
  ok:true,cwd,scope:{entityId:101,name},state:'changed',viewRevision:'issued-view',
  changes:[{id:201,kind:'updated',text:'Known task decision updated'}],...extras,
});
function chooseTask(app) {
  field(card(app,'task-changes'),'Current entity ID').props.onChange({target:{value:'101'}});
  return app.render();
}
await check(async()=>{
  const app=await context(), requests=app.server.tasks;
  assert(!button(card(app,'task-changes'),'Save this checkpoint'),'save shown before a preview');
  chooseTask(app);
  const get=await answer(app,requests,button(card(app,'task-changes'),'Check changes'),peek(ALPHA));
  assert(get.method==='GET'&&cwdOf(get.href)===ALPHA&&new URL(get.href,'http://local/').searchParams.get('entityId')==='101','preview is not a scoped GET');
  assert(requests.length===1&&textOf(card(app,'task-changes')).includes('Known task decision updated'),'read did not render by itself');
  const post=await answer(app,requests,button(card(app,'task-changes'),'Save this checkpoint'),
    peek(ALPHA,'ALPHA_CURRENT',{state:'unchanged',receipt:{action:'remembered'},checkpointAt:'2026-01-01'}));
  assert(post.method==='POST'&&cwdOf(post.href)===ALPHA,'explicit save is not a scoped POST');
  same(post.body,{entityId:101,viewRevision:'issued-view',action:'remember'},'save lost the latest server token');
  assert(textOf(card(app,'task-changes')).includes('Task checkpoint saved.'),'no acknowledged save');
},'Check changes is only a GET; explicit checkpoint save posts the issued revision');

await check(async()=>{
  const app=await context(), requests=app.server.tasks;
  chooseTask(app);
  await answer(app,requests,button(card(app,'task-changes'),'Check changes'),peek(ALPHA));
  await answer(app,requests,button(card(app,'task-changes'),'Save this checkpoint'),
    {ok:false,code:'TASK_CHANGES_PREVIEW_CHANGED',message:'Changed'},409);
  assert(textOf(card(app,'task-changes')).includes('Check again before saving')&&!button(card(app,'task-changes'),'Save this checkpoint'),'409 still permits old save');
  const late=button(card(app,'task-changes'),'Check changes').props.onClick(); await settle(1); app.render();
  const old=requests.at(-1);
  const workspace=nodesOf(app.tree()).find(n=>n.type==='select'&&n.props?.value===ALPHA);
  assert(workspace,'workspace selector missing');
  workspace.props.onChange({target:{value:BETA}}); await settle(); app.render();
  chooseTask(app);
  await answer(app,requests,button(card(app,'task-changes'),'Check changes'),peek(BETA,'BETA_CURRENT'));
  old.reply(200,peek(ALPHA,'LATE_OTHER_SCOPE')); await late; await settle(); app.render();
  const shown=textOf(card(app,'task-changes'));
  assert(shown.includes('BETA_CURRENT')&&!shown.includes('LATE_OTHER_SCOPE'),'late other-workspace result replaced B');
},'Stale checkpoint conflicts require rechecking, and an Alpha reply arriving after the switch cannot replace Beta');

const SA={sourceId:'team-a/guide.md',documentId:'301',revision:'saved-a'}, SB={sourceId:'team-b/guide.md',documentId:'302',revision:'saved-b'};
await check(async()=>{
  const app=await context(), requests=app.server.documents;
  const catalog=await answer(app,requests,button(sourceCard(app),'Load or refresh sources'),
    {ok:true,documents:[{...SA,content:'not included in selection'},SB],nextDocumentAfter:null});
  assert(cwdOf(catalog.href)===ALPHA&&new URL(catalog.href,'http://local/').searchParams.get('sourcesOnly')==='1','source picker included unrelated links');
  const checks=nodesOf(sourceCard(app)).filter(n=>n.type==='input'&&n.props.type==='checkbox');
  assert(checks.length===2,'same-basename sources missing'); checks[0].props.onChange(); app.render();
  nodesOf(sourceCard(app)).filter(n=>n.type==='input'&&n.props.type==='checkbox')[1].props.onChange(); app.render();
  field(sourceCard(app),'Search selected sources').props.onChange({target:{value:'  atlas needle  '}}); app.render();
  const sent=await answer(app,requests,button(sourceCard(app),'Find original text'),{
    ok:true,fragments:[{...SA,text:'Original A excerpt',start:{line:2,column:1},reference:{document_id:'301',revision:'saved-a',start_byte:2,end_byte:20}},
      {...SB,text:'Original B excerpt',start:{line:3,column:1},reference:{document_id:'302',revision:'saved-b',start_byte:3,end_byte:21}}],
  });
  assert(sent.href.includes('/search-sources?')&&cwdOf(sent.href)===ALPHA,'search is not source-scoped');
  same(sent.body,{sources:[SA,SB],query:'atlas needle'},'search must send exact tuples only');
  const shown=textOf(sourceCard(app));
  for(const expected of ['team-a/guide.md','team-b/guide.md','Original A excerpt','Original B excerpt']) assert(shown.includes(expected),'missing '+expected);
},'Source picker sends the exact saved source/document/revision tuples and displays separate attributable excerpts');

await check(async()=>{
  const app=await context(), requests=app.server.documents, quote='One identical quote.';
  const reference={document_id:'301',revision:'saved-a',start_byte:20,end_byte:40};
  const linkage=(evidenceId,factId,sourceId,reference,needsReview)=>({
    evidenceId,factId,sourceId,reference,needsReview,quote,status:needsReview?'source_changed':'current',
  });
  const links=[linkage(10,201,SA.sourceId,reference,false),linkage(11,202,SA.sourceId,reference,true),
    linkage(12,203,SB.sourceId,{...reference,document_id:'302',revision:'saved-b'},false)];
  const got=await answer(app,requests,button(card(app,'document-evidence'),'Load source and links'),{
    ok:true,links,documents:[],citationGroups:[{key:'first',evidenceIds:[10,11]},{key:'second',evidenceIds:[12]}],
  });
  assert(new URL(got.href,'http://local/').searchParams.get('groupCitations')==='1','grouping was not explicitly requested');
  const groups=nodesOf(card(app,'document-evidence')).filter(n=>n.props?.['data-document-citation-count']);
  same(groups.map(n=>n.props['data-document-citation-count']),[2,1],'same wording from a different source was wrongly merged');
  const merged=textOf(groups[0]), separate=textOf(groups[1]);
  assert(merged.split(quote).length===2&&merged.includes('#201')&&merged.includes('#202')&&merged.includes('Needs review')&&merged.includes('Source and fact unchanged'),'group repeats text or loses original fact references/status');
  assert(separate.includes(SB.sourceId)&&separate.includes('#203')&&separate.includes(quote)&&!separate.includes('#201'),'independent source lost');
},'Same-source duplicate quote renders once with both linked fact IDs and statuses; unrelated source stays separate');


await check(async()=>{
  const app=await context(), requests=app.server.documents;
  const docs=()=>card(app,'document-evidence');
  const makeLink=(evidenceId,factId,quote,start,needsReview=false)=>({
    evidenceId,factId,quote,sourceId:SA.sourceId,needsReview,status:needsReview?'source_changed':'current',
    reference:{document_id:'301',revision:'saved-a',start_byte:start,end_byte:start+quote.length},
  });
  const matching=makeLink(10,201,'Repeated exact excerpt.',10);
  const irrelevant=makeLink(11,202,'Unrelated page-one sentinel.',40);
  await answer(app,requests,button(docs(),'Load source and links'),{
    ok:true,links:[matching,irrelevant],documents:[],nextEvidenceAfter:11,
    citationGroups:[{key:'stable-repeat',evidenceIds:[10]},{key:'page-one-only',evidenceIds:[11]}],
  });
  assert(textOf(docs()).includes(irrelevant.quote),'page one fixture was never displayed');
  const next=nodesOf(docs()).find(n=>typeof n.props?.onClick==='function'&&typeof n.props.children==='string'&&
    /(?:more|next).*(?:link|evidence)|(?:link|evidence).*(?:more|next)/i.test(n.props.children));
  const matchedNext=makeLink(12,203,matching.quote,10,true);
  const separateNext=makeLink(13,204,'Different page-two excerpt.',80);
  const page=await answer(app,requests,next,{
    ok:true,links:[matchedNext,separateNext],documents:[],nextEvidenceAfter:null,
    citationGroups:[{key:'stable-repeat',evidenceIds:[12]},{key:'page-two-only',evidenceIds:[13]}],
  });
  assert(new URL(page.href,'http://local/').searchParams.get('evidenceAfter')==='11','page two lost its own cursor');
  const visible=textOf(docs());
  assert(!visible.includes(irrelevant.quote)&&!visible.includes('#202'),'different quote leaked from the previous page');
  const groups=nodesOf(docs()).filter(n=>n.props?.['data-document-citation-count']);
  same(groups.map(n=>n.props['data-document-citation-count']),[2,1],'only a repeated key should carry forward');
  const matched=textOf(groups[0]), separated=textOf(groups[1]);
  assert(matched.split(matching.quote).length===2&&matched.includes('#201')&&matched.includes('#203')&&matched.includes('Needs review'),
    'cross-page merge must keep both facts and their status without repeating the excerpt');
  assert(separated.includes(separateNext.quote)&&separated.includes('#204'),'page-two unique group missing');
},'Page two keeps its independent groups and carries forward only exact earlier duplicate citations');

console.log(JSON.stringify({checks,failures,layer:'raw client.js VM; controlled HTTP; no browser/host/network'}));
process.exitCode=failures?1:0;
