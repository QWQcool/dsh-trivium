/** B-batch behaviour: workspace switching, drafts, tab keyboard, receipts, import preview.
 * Same harness as smoke-p24: the real component runs under a minimal React shim and
 * every request is answered by hand. No DOM is emulated, so keyboard assertions
 * check the handlers' contract (aria-*, roving tabindex) rather than pixels; the
 * browser pass covers the pixels.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { closeAll, dbFingerprint, importGraph, nodeCountOf, openWorkspaceDb, planImportGraph } from "../lib/store.js";

const source = readFileSync(process.env.DSH_TRIVIUM_CLIENT_SOURCE || fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const A = "C:\\audit\\workspace-a";
const B = "C:\\audit\\workspace-b";
const workspaceList = [
  { cwd: A, path: A + "\\.dsh\\trivium.tdb", nodeCount: 1, open: true },
  { cwd: B, path: B + "\\.dsh\\trivium.tdb", nodeCount: null, open: false },
];
const status = { ok: true, cwd: A, version: "0.7.1", chipsEnabled: false, recallMode: "off", workspaces: workspaceList };
const row = (id, text) => ({ id, type: "preference", name: "n" + id, text });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function panel() {
  const hooks = [], effects = [], pending = [], requests = [];
  let cursor = 0, dirty = true, mounted = false, tree, component, registration;
  let confirmations = 0, confirmResult = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    Fragment: "fragment",
    useState(init) {
      const i = cursor++;
      hooks[i] ??= { value: typeof init === "function" ? init() : init };
      return [hooks[i].value, (next) => {
        const value = typeof next === "function" ? next(hooks[i].value) : next;
        if (!Object.is(hooks[i].value, value)) { hooks[i].value = value; dirty = true; }
      }];
    },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!same(hooks[i]?.deps, deps)) hooks[i] = { value: fn(), deps };
      return hooks[i].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(hooks[i]?.deps, deps)) {
        const previous = hooks[i];
        hooks[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); hooks[i].cleanup = fn(); });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { registration = def; } }, confirm() { confirmations++; return confirmResult; } },
    URL, URLSearchParams, setTimeout, clearTimeout, console,
    fetch(url, options = {}) {
      if (!mounted) return Promise.resolve({ ok: true, status: 200, json: async () => status });
      return new Promise((resolve, reject) => {
        const request = { url: new URL(url, "http://test"), options, resolve, reject };
        pending.push(request); requests.push(request);
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "lib/client.js" });
  const mod = registration.factory((name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Button: "button" };
    throw new Error("Unexpected require: " + name);
  });
  mod.apply({
    workspaces: {}, sessions: {}, on() {},
    slots: { inject(_name, fn) { fn(); }, register(entry, render) { if (entry.id === "dsh-trivium") component = render; return { dispose() {} }; } },
  });
  await tick();
  mounted = true;
  async function flush() {
    for (let i = 0; i < 10; i++) {
      if (dirty) { cursor = 0; dirty = false; tree = component(); while (effects.length) effects.shift()(); }
      await tick();
    }
  }
  function elements(value = tree, out = []) {
    if (Array.isArray(value)) value.forEach((v) => elements(v, out));
    else if (value && typeof value === "object") { out.push(value); elements(value.props?.children ?? null, out); }
    return out;
  }
  function text(value = tree) {
    if (Array.isArray(value)) return value.map((v) => text(v)).join(" ");
    if (value && typeof value === "object") return text(value.props?.children ?? null);
    return value == null || value === false ? "" : String(value);
  }
  function take(path) {
    const i = pending.findIndex((r) => r.url.pathname === "/api/dsh-trivium/" + path);
    assert.ok(i >= 0, "Expected request: " + path + "; pending: " + pending.map((r) => r.url.pathname));
    return pending.splice(i, 1)[0];
  }
  async function reply(request, data, ok = true, httpStatus = ok ? 200 : 500) {
    request.resolve({ ok, status: httpStatus, json: async () => data });
    await flush();
  }
  const button = (label) => elements().find((el) => el.type === "button" && text(el) === label);
  const byLabel = (label) => elements().find((el) => el.props["aria-label"] === label);
  const tablist = () => elements().find((el) => el.props.role === "tablist");
  const tabs = () => elements().filter((el) => el.props.role === "tab");
  await flush();
  return {
    flush, elements, text, take, reply, button, byLabel, tablist, tabs,
    pending, requests,
    get confirmations() { return confirmations; },
    setConfirm(value) { confirmResult = value; },
  };
}

async function loaded(nodes = [row(2, "Displayed workspace A memory")], statusPatch = {}) {
  const p = await panel();
  await p.reply(p.take("status"), { ...status, ...statusPatch });
  await p.reply(p.take("nodes"), { nodes });
  await p.reply(p.take("external"), { files: [] });
  return p;
}

const workspaceSelect = (p) => p.byLabel("Pick a known workspace");
const changeWorkspace = async (p, cwd) => {
  workspaceSelect(p).props.onChange({ target: { value: cwd } });
  await p.flush();
};
/** Edit fields only exist once the entry is expanded; the header itself is the toggle. */
const expandEntry = async (p, id) => {
  const header = p.elements().find((el) => el.type === "button" && p.text(el).startsWith("#" + id + " "));
  assert.ok(header, "entry header is a native button");
  header.props.onClick();
  await p.flush();
};

const tests = [
  ["recovery status is truthful for running, timeout, failure and success and can be refreshed", async () => {
    const p = await loaded([], { recovery: { state: "running-timed-out" } });
    await p.tabs()[1].props.onClick(); await p.flush();
    assert.match(p.text(), /wait timed out; recovery is still running/);
    assert.doesNotMatch(p.text(), /latest recovery completed/);
    const refresh = p.button("Refresh recovery status");
    assert.ok(refresh, "recovery refresh is a native button");
    refresh.props.onClick(); await p.flush();
    const request = p.take("status");
    assert.equal(request.url.searchParams.get("cwd"), A);
    await p.reply(request, { ...status, recovery: { state: "failed" } });
    assert.match(p.text(), /latest recovery did not complete/);
    refresh.props.onClick(); await p.flush();
    await p.reply(p.take("status"), { ...status, recovery: { state: "succeeded" } });
    assert.match(p.text(), /latest recovery completed/);
    refresh.props.onClick(); await p.flush();
    await p.reply(p.take("status"), { ...status, recovery: { state: "running" } });
    assert.match(p.text(), /Recovering pending memory/);
    refresh.props.onClick(); await p.flush();
    await p.reply(p.take("status"), { ...status, recovery: { state: "pending" }, pendingPersistence: { incomplete: true } });
    assert.match(p.text(), /Some content is still awaiting recovery/);
    assert.match(p.text(), /some content may not be safely saved/);
    assert.doesNotMatch(p.text(), /latest recovery completed/);
    refresh.props.onClick(); await p.flush();
    await p.reply(p.take("status"), { ...status, recovery: null });
    assert.match(p.text(), /No recovery status has been recorded in this process/);
  }],
  ["the changes panel shows record details, retention, empty and failed states", async () => {
    const p = await loaded(undefined, { audit: { incomplete: true, scope: "process" } });
    await p.tabs()[1].props.onClick();
    await p.flush();
    assert.match(p.text(), /Loading change records/);
    const req = p.take("changes");
    assert.equal(req.url.searchParams.get("cwd"), A);
    await p.reply(req, { entries: [{ reason: "created", at: "2026-10-30T10:11:12Z", source: { role: "user", seq: 42, messageId: "abcdefgh1234" }, preview: "synthetic memory" }], trimmed: 2, labels: { created: { en: "Created", zh: "已写入" } } });
    assert.match(p.text(), /Memory changes/);
    assert.match(p.text(), /Some changes could not be recorded/);
    assert.match(p.text(), /Created/);
    assert.match(p.text(), /2026-10-30 10:11:12/);
    assert.match(p.text(), /user · #42 · abcdefgh/);
    assert.match(p.text(), /synthetic memory/);
    assert.match(p.text(), /Older records are beyond retention/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    await p.reply(p.take("changes"), { entries: [], trimmed: 0 });
    assert.match(p.text(), /Nothing written yet/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    await p.reply(p.take("changes"), { message: "offline" }, false);
    assert.match(p.text(), /Could not read the change record/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    assert.match(p.text(), /Loading change records/);
    assert.doesNotMatch(p.text(), /Could not read the change record/);
    await p.reply(p.take("changes"), { entries: [{ reason: "created", preview: "recovered entry" }] });
    assert.match(p.text(), /recovered entry/);
  }],
  ["a persisted audit gap stays visible after a process restart and later successful write", async () => {
    const p = await loaded(undefined, { audit: { incomplete: false, scope: "process" } });
    await p.tabs()[1].props.onClick(); await p.flush();
    await p.reply(p.take("changes"), { incomplete: true, entries: [{ reason: "written", preview: "older entry" }] });
    assert.match(p.text(), /Some changes could not be recorded/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    await p.reply(p.take("changes"), { incomplete: true, entries: [{ reason: "written", preview: "later successful entry" }] });
    assert.match(p.text(), /later successful entry/);
    assert.match(p.text(), /Some changes could not be recorded/, "new successful entries do not erase the historical gap warning");
  }],
  ["switching workspaces clears changes and ignores delayed responses and errors", async () => {
    const p = await loaded();
    await p.tabs()[1].props.onClick(); await p.flush();
    const first = p.take("changes");
    await p.reply(first, { entries: [{ reason: "created", preview: "only workspace A" }] });
    assert.match(p.text(), /only workspace A/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    const delayedA = p.take("changes");
    await changeWorkspace(p, B);
    assert.doesNotMatch(p.text(), /only workspace A/, "old records must disappear immediately on switch");
    await p.reply(p.take("status"), { ...status, cwd: B });
    const requestB = p.take("changes");
    assert.equal(requestB.url.searchParams.get("cwd"), B);
    await p.reply(requestB, { entries: [{ reason: "created", preview: "only workspace B" }] });
    await p.reply(delayedA, { entries: [{ reason: "created", preview: "late workspace A" }] });
    assert.match(p.text(), /only workspace B/);
    assert.doesNotMatch(p.text(), /late workspace A/);
    await p.tabs()[0].props.onClick(); await p.flush();
    await p.tabs()[1].props.onClick(); await p.flush();
    const outdatedB = p.take("changes");
    await changeWorkspace(p, A);
    await p.reply(p.take("status"), status);
    await p.reply(p.take("changes"), { entries: [{ reason: "created", preview: "new workspace A" }] });
    await p.reply(outdatedB, { message: "obsolete failure" }, false);
    assert.match(p.text(), /new workspace A/);
    assert.doesNotMatch(p.text(), /Could not read the change record/);
  }],
  ["the workspace picker lists every known workspace and switching rebinds every request", async () => {
    const p = await loaded();
    const select = workspaceSelect(p);
    assert.ok(select, "workspace picker is rendered");
    assert.equal(select.props.children.length, 2, "both known workspaces are offered");
    assert.equal(select.props.value, A, "the picker shows the library on screen");

    await changeWorkspace(p, B);
    const st = p.take("status");
    assert.equal(st.url.searchParams.get("cwd"), B, "status is asked for the new workspace");
    await p.reply(st, { ...status, cwd: B, nodeCount: 3, dbPath: B + "\\.dsh\\trivium.tdb" });
    const nodes = p.take("nodes");
    assert.equal(nodes.url.searchParams.get("cwd"), B, "the list follows the switch");
    await p.reply(nodes, { nodes: [row(9, "Workspace B memory")] });
    await p.reply(p.take("external"), { files: [] });
    assert.match(p.text(), /Workspace B memory/, "list now shows the new library");
    assert.doesNotMatch(p.text(), /Displayed workspace A memory/, "old nodes are gone");
  }],
  ["an unsaved draft blocks the switch until the user chooses what to do", async () => {
    const p = await loaded();
    await expandEntry(p, 2);
    const nameInput = p.elements().find((el) => el.type === "input" && el.props.value === "n2");
    assert.ok(nameInput, "entry name field is editable once expanded");
    nameInput.props.onChange({ target: { value: "edited but unsaved" } });
    await p.flush();

    await changeWorkspace(p, B);
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/status")), "no request while the draft is unresolved");
    assert.match(p.text(), /unsaved edit/, "the panel asks instead of dropping the draft");

    p.button("Discard changes and switch").props.onClick();
    await p.flush();
    const st = p.take("status");
    assert.equal(st.url.searchParams.get("cwd"), B, "discarding is an explicit choice, then the switch happens");
  }],
  ["save-and-switch commits the draft first and only then reloads the new library", async () => {
    const p = await loaded();
    await expandEntry(p, 2);
    const nameInput = p.elements().find((el) => el.type === "input" && el.props.value === "n2");
    assert.ok(nameInput, "entry name field is editable once expanded");
    nameInput.props.onChange({ target: { value: "kept" } });
    await p.flush();
    await changeWorkspace(p, B);

    p.button("Save and switch").props.onClick();
    await p.flush();
    const save = p.take("nodes/2");
    assert.equal(save.options.method, "POST", "draft is written before switching");
    assert.equal(save.url.searchParams.get("cwd"), A, "the draft is written to the library it belongs to");
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/status")), "no switch before the save resolves");

    await p.reply(save, { ok: true });
    const st = p.take("status");
    assert.equal(st.url.searchParams.get("cwd"), B, "switch happens after the save");
  }],
  ["memory tabs are a real tablist: roving tabindex and arrow keys", async () => {
    const p = await loaded();
    const bar = p.tablist();
    assert.ok(bar, "tablist exists");
    assert.equal(typeof bar.props.onKeyDown, "function", "the tab strip handles arrow keys");
    const [first, second] = p.tabs();
    assert.equal(first.props["aria-selected"], "true", "list tab starts selected");
    assert.equal(first.props.tabIndex, 0, "selected tab is the tab stop");
    assert.equal(second.props.tabIndex, -1, "other tabs are skipped by Tab");

    bar.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
    await p.flush();
    const after = p.tabs();
    assert.equal(after[1].props["aria-selected"], "true", "arrow key moves selection to recall");
    assert.equal(after[1].props.tabIndex, 0, "focus target follows selection");
  }],
  ["a successful archive produces one committed receipt naming the object", async () => {
    const p = await loaded();
    p.button("Archive").props.onClick();
    await p.flush();
    const receipt = p.elements().find((el) => el.props["data-receipt-state"] === "pending");
    assert.ok(receipt, "a receipt appears while the write is in flight");
    assert.match(p.text(receipt), /#2/, "the receipt names the node");

    await p.reply(p.take("nodes/2/archive"), { ok: true });
    const done = p.elements().find((el) => el.props["data-receipt-state"] === "saved");
    assert.ok(done, "the receipt becomes committed only after the server answers");
    assert.match(p.text(done), /#2/, "committed receipt keeps the object identity");
  }],
  ["a rejected write keeps the server code instead of reporting success", async () => {
    const p = await loaded();
    p.button("Archive").props.onClick();
    await p.flush();
    await p.reply(p.take("nodes/2/archive"), { ok: false, code: "REVISION_LINKED", message: "chain protected" }, false, 409);
    const rejected = p.elements().find((el) => el.props["data-receipt-state"] === "rejected");
    assert.ok(rejected, "409 is a rejection, not a silent success");
    assert.match(p.text(rejected), /REVISION_LINKED/, "server code is preserved");
  }],
  ["import previews first, commits only on confirm, and reports real counts", async () => {
    const p = await loaded();
    const fileInput = p.elements().find((el) => el.type === "input" && el.props.type === "file");
    assert.ok(fileInput, "a file input exists");
    const file = { name: "export.json", text: async () => JSON.stringify({ nodes: [], edges: [] }) };
    fileInput.props.onChange({ target: { files: [file] } });
    await p.flush();

    const preview = p.take("import");
    const ask = JSON.parse(preview.options.body);
    assert.equal(ask.preview, true, "the first request is a dry run");
    assert.ok(ask.graph, "the parsed graph is what gets posted");
    await p.reply(preview, {
      ok: true,
      dryRun: true,
      preview: { created: [{ id: 9, name: "new fact", type: "preference" }], updated: [], archived: [], relations: { business: 2, revision: 1 } },
      fingerprint: "fp-1",
      version: 2,
    });

    const panel = p.elements().find((el) => el.props["data-import-preview"] === "ready");
    assert.ok(panel, "a read-only preview panel is rendered");
    assert.match(p.text(panel), /new fact/, "the preview names what would be created");
    assert.ok(
      !p.requests.some((r) => r.url.pathname.endsWith("/import") && JSON.parse(r.options.body).preview !== true),
      "previewing never commits",
    );

    p.button("Confirm import").props.onClick();
    await p.flush();
    const commit = p.take("import");
    assert.equal(JSON.parse(commit.options.body).expectFingerprint, "fp-1", "the commit carries the preview fingerprint");
    await p.reply(commit, { ok: true, created: 3, merged: 1, linked: 2, revisionLinked: 1 });
    await p.reply(p.take("status"), { ...status, derived: { sidecar: { ok: false, error: "jsonl locked" } } });
    await p.reply(p.take("nodes"), { nodes: [row(2, "after import")] });
    await p.reply(p.take("external"), { files: [] });

    const saved = p.elements().find((el) => el.props["data-receipt-state"] === "saved");
    assert.ok(saved, "a successful import produces a committed receipt");
    assert.match(p.text(saved), /created 3/, "counts come from the response, not from a guess");
    assert.match(p.text(saved), /derived maintenance failed/, "a failed sidecar write is stated next to the committed facts");
    assert.match(p.text(saved), /Do not re-import/, "the recovery text does not invite a duplicate write");
    assert.ok(
      !p.elements().some((el) => el.props["data-receipt-state"] === "waiting"),
      "the preview waiting receipt is withdrawn when the commit starts",
    );
    assert.ok(!p.elements().some((el) => el.props["data-import-preview"]), "the panel closes after the commit");
  }],
  ["cancelling a preview sends no commit and no write receipt", async () => {
    const p = await loaded();
    const fileInput = p.elements().find((el) => el.type === "input" && el.props.type === "file");
    fileInput.props.onChange({ target: { files: [{ name: "cancel.json", text: async () => "{\"nodes\":[],\"edges\":[]}" }] } });
    await p.flush();
    await p.reply(p.take("import"), {
      ok: true,
      dryRun: true,
      preview: { created: [], updated: [], archived: [], relations: { business: 0, revision: 0 } },
      fingerprint: "fp-2",
    });
    assert.ok(p.elements().some((el) => el.props["data-import-preview"] === "ready"), "preview is on screen");
    assert.match(p.text(), /would not change any node/, "an empty diff is stated instead of an empty table");

    p.button("Cancel").props.onClick();
    await p.flush();
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/import")), "cancel issues no commit");
    assert.ok(!p.elements().some((el) => el.props["data-import-preview"]), "cancel closes the panel");
    assert.ok(!p.elements().some((el) => el.props["data-receipt-state"] === "waiting"), "the waiting receipt is withdrawn");
  }],
  ["a stale preview is refused and asks for a fresh one", async () => {
    const p = await loaded();
    const fileInput = p.elements().find((el) => el.type === "input" && el.props.type === "file");
    fileInput.props.onChange({ target: { files: [{ name: "race.json", text: async () => "{\"nodes\":[],\"edges\":[]}" }] } });
    await p.flush();
    await p.reply(p.take("import"), { ok: true, dryRun: true, preview: { created: [], updated: [], archived: [], relations: {} }, fingerprint: "fp-old" });
    p.button("Confirm import").props.onClick();
    await p.flush();
    await p.reply(p.take("import"), { ok: false, code: "STALE_PREVIEW", message: "workspace changed" }, false, 409);

    const rejected = p.elements().find((el) => el.props["data-receipt-state"] === "rejected");
    assert.ok(rejected, "the refused commit is visible");
    assert.match(p.text(rejected), /STALE_PREVIEW/, "the code explains why");
    const stale = p.elements().find((el) => el.props["data-import-preview"] === "stale");
    assert.ok(stale, "the panel switches to the stale state instead of silently retrying");
    assert.match(p.text(stale), /Nothing was written/, "the user is told nothing changed");
  }],
  ["a rejected import keeps the server code and writes nothing", async () => {
    const p = await loaded();
    const fileInput = p.elements().find((el) => el.type === "input" && el.props.type === "file");
    fileInput.props.onChange({
      target: { files: [{ name: "bad.json", text: async () => JSON.stringify({ nodes: [{ id: 1 }], edges: [] }) }] },
    });
    await p.flush();
    await p.reply(p.take("import"), { ok: false, code: "REVISION_LINKED", message: "not written" }, false, 409);
    const rejected = p.elements().find((el) => el.props["data-receipt-state"] === "rejected");
    assert.ok(rejected, "409 is reported as rejected");
    assert.match(p.text(rejected), /REVISION_LINKED/, "the import code is preserved for the user");
    assert.ok(!p.elements().some((el) => el.props["data-import-preview"]), "a refused pre-check leaves no preview behind");
  }],
  ["invalid JSON never reaches the server", async () => {
    const p = await loaded();
    const fileInput = p.elements().find((el) => el.type === "input" && el.props.type === "file");
    fileInput.props.onChange({ target: { files: [{ name: "broken.json", text: async () => "{not json" }] } });
    await p.flush();
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/import")), "no import request for unparsable input");
    // Not a server rejection: nothing was sent. It is a client-side failure
    // the user can retry with another file.
    const failed = p.elements().find((el) => el.props["data-receipt-state"] === "failed");
    assert.ok(failed, "the failure is still reported as a receipt");
    assert.match(p.text(failed), /BAD_JSON/, "the local parse failure has its own code");
  }],
  ["this turn shows only delivered blocks and explains its own emptiness", async () => {
    const p = await loaded();
    await p.tabs()[1].props.onClick();
    await p.flush();
    await p.reply(p.take("recall-traces"), { traces: [] });
    await p.reply(p.take("corrections"), { sessions: [] });
    await p.reply(p.take("turn"), {
      ok: true,
      budget: 300,
      sessions: [
        {
          sessionId: "s1",
          turnKey: "uid:7f3a",
          spent: 126,
          records: [{ id: 2, type: "preference", channel: "recall", tokens: 61, l0: "delivered body" }],
          corrections: { pending: [{ id: 9, note: "changed" }], sent: [] },
        },
      ],
    });
    const live = p.elements().find((el) => el.props["data-turn-section"] === "live");
    assert.ok(live, "the delivered-turn section renders from the ledger");
    assert.match(p.text(live), /delivered body/, "only the real delivery is listed");
    assert.match(p.text(live), /126/, "the budget bar uses the ledger's spent estimate");
    assert.match(p.text(live), /Corrections waiting/, "pending corrections are surfaced next to the delivery");
    assert.match(p.text(live), /Candidates are not deliveries/, "the panel keeps candidates and deliveries apart");
  }],
  ["an empty ledger says so instead of inventing history", async () => {
    const p = await loaded();
    await p.tabs()[1].props.onClick();
    await p.flush();
    await p.reply(p.take("recall-traces"), { traces: [] });
    await p.reply(p.take("corrections"), { sessions: [] });
    await p.reply(p.take("turn"), { ok: true, budget: 300, sessions: [] });
    const empty = p.elements().find((el) => el.props["data-turn-section"] === "empty");
    assert.ok(empty, "the section renders the empty state");
    assert.match(p.text(empty), /No delivery record/, "a restart is stated, not faked");
    assert.match(p.text(empty), /process/, "the panel says the ledger is process-local");
  }],
  ["permanent deletion confirms the exact object before any request", async () => {
    const p = await loaded();
    p.button("Delete").props.onClick();
    await p.flush();
    const dialog = p.elements().find((el) => el.props.role === "alertdialog");
    assert.ok(dialog, "the panel renders its own confirmation instead of a native dialog");
    assert.match(p.text(dialog), /#2/, "the dialog names the exact object");
    p.elements().find((el) => el.type === "button" && p.text(el) === "Cancel").props.onClick();
    await p.flush();
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/delete")), "cancelled deletion sends nothing");
    assert.ok(!p.elements().some((el) => el.props["data-receipt-action"] === "delete"), "no receipt for a cancelled action");
    assert.ok(!p.elements().some((el) => el.props.role === "alertdialog"), "cancelling closes the confirmation");
  }],
  ["an explicit settings save produces its own receipt", async () => {
    const p = await loaded();
    const fold = p.elements().find((el) => el.type === "button" && p.text(el).startsWith("Settings"));
    assert.ok(fold, "the configuration fold exists");
    fold.props.onClick();
    await p.flush();
    // Opening the fold persists configPanelOpen; answer that write before the
    // explicit save so its button is not in the busy label.
    await p.reply(p.take("settings"), { ok: true });
    await p.reply(p.take("status"), { ...status });
    await p.reply(p.take("nodes"), { nodes: [row(2, "after fold")] });
    await p.reply(p.take("external"), { files: [] });
    const save = p.button("Save settings");
    assert.ok(save, "the save control lives with the settings it writes");
    save.props.onClick();
    await p.flush();
    const pending = p.elements().find(
      (el) => el.props["data-receipt-action"] === "settings" && el.props["data-receipt-state"] === "pending",
    );
    assert.ok(pending, "a settings save is pending before the server answers");
    await p.reply(p.take("settings"), { ok: true });
    await p.reply(p.take("status"), { ...status });
    await p.reply(p.take("nodes"), { nodes: [row(2, "after settings")] });
    await p.reply(p.take("external"), { files: [] });
    const saved = p.elements().find(
      (el) => el.props["data-receipt-action"] === "settings" && el.props["data-receipt-state"] === "saved",
    );
    assert.ok(saved, "the settings receipt becomes committed only after the response");
  }],
];

/*
 * Backend half: the preview must be the same plan the commit runs, and a stale
 * fingerprint must not write. This asserts the database, not a dryRun flag.
 */
{
  const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p26-"));
  process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
  const cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  const db = await openWorkspaceDb(cwd);
  const graph = {
    version: 2,
    nodes: [
      { id: 1, payload: { type: "preference", name: "auth", text: "header X", uri: "demo:auth" } },
      { id: 2, payload: { type: "decision", name: "old", text: "old", uri: "demo:old" } },
    ],
    edges: [{ from: 1, to: 2, label: "about" }],
  };
  const before = nodeCountOf(db);
  const fp0 = dbFingerprint(db);

  try {
    const planned = planImportGraph(db, graph);
    assert.equal(planned.ok, true, "planning succeeds");
    assert.equal(planned.summary.created.length, 2, "two new nodes are planned");
    assert.equal(planned.summary.relations.business, 1, "the business edge is counted");
    assert.equal(nodeCountOf(db), before, "planning writes no node");
    assert.equal(dbFingerprint(db), fp0, "planning does not move the fingerprint");

    const committed = importGraph(db, graph, { expectFingerprint: fp0 });
    assert.equal(committed.ok, true, "the same graph commits");
    assert.equal(committed.created, 2);
    const fp1 = dbFingerprint(db);
    assert.notEqual(fp1, fp0, "committing changes the fingerprint");

    const stale = importGraph(
      db,
      { ...graph, nodes: graph.nodes.concat([{ id: 3, payload: { type: "entity", name: "x", text: "x", uri: "demo:x" } }]) },
      { expectFingerprint: fp0 },
    );
    assert.equal(stale.ok, false, "a stale fingerprint is refused");
    assert.equal(stale.code, "STALE_PREVIEW");
    assert.equal(nodeCountOf(db), before + 2, "the refused commit left the database alone");

    const again = planImportGraph(db, graph);
    assert.equal(again.summary.created.length, 0, "re-planning the same file creates nothing new");
    assert.equal(again.summary.updated.length, 2, "it becomes an update instead");
    console.log("ok  backend: planImportGraph is a real dry run and a stale fingerprint writes nothing");
  } finally {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  }
}

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log("ok  " + name);
  } catch (err) {
    failed += 1;
    console.log("FAIL " + name + "\n     " + (err && err.message));
  }
}
console.log("\nP26 B-batch behaviour: " + (tests.length - failed) + "/" + tests.length + " passed");
if (failed) process.exit(1);
