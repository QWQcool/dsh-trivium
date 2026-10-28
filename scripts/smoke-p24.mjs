/** Execute the real settings component with controlled fetch ordering.
 * No DOM/host is emulated: keyboard assertions check native button semantics;
 * visual/focus behavior still requires the desktop/browser acceptance pass.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(process.env.DSH_TRIVIUM_CLIENT_SOURCE || fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const A = "C:\\audit\\workspace-a";
const status = { ok: true, cwd: A, version: "0.7.0", chipsEnabled: false, recallMode: "off" };
const row = (text) => ({ id: 2, type: "preference", text });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function panel() {
  const hooks = [], effects = [], pending = [], requests = [];
  let cursor = 0, dirty = true, mounted = false, tree, component, registration;
  let confirmations = 0;
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
    window: { __ModuleLoader__: { load(def) { registration = def; } }, confirm() { confirmations++; return false; } },
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
  async function reply(request, data, ok = true) {
    request.resolve({ ok, status: ok ? 200 : 500, json: async () => data });
    await flush();
  }
  const button = (label) => elements().find((el) => el.type === "button" && text(el) === label);
  async function search(query) {
    const input = elements().find((el) => el.type === "input" && String(el.props.placeholder).startsWith("Search"));
    assert.ok(input, "search input exists");
    input.props.onChange({ target: { value: query } });
    await flush();
  }
  await flush();
  return { flush, elements, text, take, reply, button, search, pending, requests, get confirmations() { return confirmations; } };
}

async function loaded(nodes = [row("Displayed workspace A memory")], statusPatch = {}) {
  const p = await panel();
  await p.reply(p.take("status"), { ...status, ...statusPatch });
  await p.reply(p.take("nodes"), { nodes });
  await p.reply(p.take("external"), { files: [] });
  return p;
}

const tests = [
  ["Escape closes only the inner revision dialog and consumes the event", async () => {
    const p = await loaded([{id:2,type:"decision",text:"old"},{id:3,type:"decision",text:"new"}]);
    p.elements().find((el) => el.type === "button" && p.text(el) === "Replace…").props.onClick();
    await p.flush();
    const dialog = p.elements().find((el) => el.props.role === "dialog");
    assert.ok(dialog, "replacement dialog opened");
    let prevented = false, stopped = false;
    assert.equal(typeof dialog.props.onKeyDown, "function");
    dialog.props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    await p.flush();
    assert.ok(prevented && stopped, "outer host dialog must not receive this Escape");
    assert.ok(!p.elements().some((el) => el.props.role === "dialog"));
  }],
  ["a real revision history does not claim the node has no history", async () => {
    const p = await loaded([{ id: 2, type: "decision", text: "Decision body" }]);
    const title = p.elements().find((el) => el.type === "button" && p.text(el).trim() === "#2 decision");
    title.props.onClick(); await p.flush();
    await p.reply(p.take("nodes/2/detail"), { ok: true });
    p.button("Decision history").props.onClick(); await p.flush();
    await p.reply(p.take("nodes/2/history"), { nodes: [{id:3,type:"decision",isCurrent:true,l0:"Current"},{id:2,type:"decision",isCurrent:false,l0:"Old"}], total: 2 });
    assert.doesNotMatch(p.text(), /No version history/);
  }],
  ["pending corrections explain disabled injection and insufficient budget", async () => {
    const p = await loaded();
    p.button("Recall check").props.onClick(); await p.flush();
    await p.reply(p.take("recall-traces"), { traces: [] });
    await p.reply(p.take("corrections"), { sessions: [{ sessionId:"test-session", pending:[{id:2,note:"changed",blockedReason:"channels-off"},{id:3,note:"changed again",blockedReason:"budget"}], sent:[] }] });
    assert.match(p.text(), /Injection is off/);
    assert.match(p.text(), /Waiting for enough budget/);
    assert.doesNotMatch(p.text(), /Takes effect on the next message/);
  }],
  ["the settings panel surfaces a failed workspace sidecar", async () => {
    const p = await loaded(undefined, { derived: { sidecar: { ok: false, error: "QA-file-blocked", cwd: A } } });
    assert.match(p.text(), /QA-file-blocked/);
    assert.ok(p.elements().some((el) => el.props.role === "alert"));
  }],
  ["late list response cannot replace the latest search results", async () => {
    const p = await panel();
    await p.reply(p.take("status"), status);
    const old = p.take("nodes");
    await p.search("new query");
    await p.reply(p.take("status"), status);
    await p.reply(p.take("nodes"), { nodes: [row("NEW RESULT")] });
    await p.reply(p.take("external"), { files: [] });
    await p.reply(old, { nodes: [row("STALE RESULT")] });
    assert.match(p.text(), /NEW RESULT/);
    assert.doesNotMatch(p.text(), /STALE RESULT/);
  }],
  ["late external-discovery error cannot overwrite a newer successful load", async () => {
    const p = await panel();
    await p.reply(p.take("status"), status);
    await p.reply(p.take("nodes"), { nodes: [row("old")] });
    const old = p.take("external");
    await p.search("new");
    await p.reply(p.take("status"), status);
    await p.reply(p.take("nodes"), { nodes: [row("NEW RESULT")] });
    await p.reply(p.take("external"), { files: [] });
    await p.reply(old, { message: "STALE ERROR" }, false);
    assert.doesNotMatch(p.text(), /STALE ERROR/);
  }],
  ["list, discovery, refresh and archive stay bound to the displayed workspace", async () => {
    const p = await loaded();
    for (const name of ["nodes", "external"]) {
      const req = p.requests.find((r) => r.url.pathname.endsWith("/" + name));
      assert.equal(req.url.searchParams.get("cwd"), A, name + " must target A even after another session activates B");
    }
    p.button("Archive").props.onClick();
    const archive = p.take("nodes/2/archive");
    assert.equal(archive.url.searchParams.get("cwd"), A, "archive targets the shown memory's workspace");
    await p.reply(archive, { ok: true });
    assert.equal(p.take("status").url.searchParams.get("cwd"), A, "refresh remains on A");
  }],
  ["node details expose a keyboard-operable native button", async () => {
    const p = await loaded();
    const title = p.elements().find((el) => typeof el.props.onClick === "function" && p.text(el).trim() === "#2 preference");
    assert.ok(title, "node title exists");
    assert.equal(title.type, "button", "Enter/Space/Tab must work without pointer input");
    assert.equal(title.props["aria-expanded"], false);
    title.props.onClick();
    await p.flush();
    assert.equal(p.take("nodes/2/detail").url.searchParams.get("cwd"), A);
    assert.ok(p.elements().some((el) => el.type === "button" && el.props["aria-expanded"] === true));
  }],
  ["cancelled permanent deletion does not send a write", async () => {
    const p = await loaded();
    p.button("Delete").props.onClick();
    await p.flush();
    assert.equal(p.confirmations, 1, "settings deletion requests confirmation, like Chips does");
    assert.ok(!p.requests.some((r) => r.url.pathname.endsWith("/delete")));
  }],
  ["mutation completion refreshes the current search rather than an older closure", async () => {
    const p = await loaded();
    p.button("Archive").props.onClick();
    const archive = p.take("nodes/2/archive");
    await p.search("new query");
    await p.reply(p.take("status"), status);
    await p.reply(p.take("nodes"), { nodes: [row("NEW RESULT")] });
    await p.reply(p.take("external"), { files: [] });
    await p.reply(archive, { ok: true });
    await p.reply(p.take("status"), status);
    assert.equal(p.take("nodes").url.searchParams.get("q"), "new query");
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try { await run(); console.log("ok  " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
}
console.log(`P24 client behavior: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
