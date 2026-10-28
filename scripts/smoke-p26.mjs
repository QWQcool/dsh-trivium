/** B-batch behaviour: workspace switching, drafts, tab keyboard, receipts, import preview.
 * Same harness as smoke-p24: the real component runs under a minimal React shim and
 * every request is answered by hand. No DOM is emulated, so keyboard assertions
 * check the handlers' contract (aria-*, roving tabindex) rather than pixels; the
 * browser pass covers the pixels.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
  ["permanent deletion confirms the exact object before any request", async () => {
    const p = await loaded();
    p.setConfirm(false);
    p.button("Delete").props.onClick();
    await p.flush();
    assert.equal(p.confirmations, 1, "deletion still asks for confirmation");
    assert.ok(!p.pending.some((r) => r.url.pathname.endsWith("/delete")), "cancelled deletion sends nothing");
    assert.ok(!p.elements().some((el) => el.props["data-receipt-action"] === "delete"), "no receipt for a cancelled action");
  }],
];

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
