/**
 * Client-side locale resolution (the Settings card and the Chips tab language).
 *
 * Regression for issue #2: with no explicit `pluginLocale` stored, "follow host"
 * rendered Simplified Chinese on an English host. Two causes lived here —
 * `ctx.locale` was read without the service ever being injected (the locale
 * plugin provides it during its own apply, and an undeclared service read is not
 * a supported `ctx` property read), and the plugin's own fallback was `zh` while
 * the host's `FALLBACK_LOCALE` is `en`.
 *
 * lib/client.js is a `window.__ModuleLoader__.load({id, factory})` bundle, and the
 * client module system resolves package-name specifiers only (anything else
 * throws), so this cannot live in a separate requireable file. This script loads
 * the real bundle with a stubbed loader plus react/primitives stubs, then drives
 * `apply()` against a stub cordis context. apply() never renders; it only
 * registers a slot, so the stubs stay this thin.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

/** react / jsx-runtime / ui-primitives stubs: no component ever renders here. */
function stubs() {
  const noop = () => {};
  return {
    react: {
      useState: (init) => [typeof init === "function" ? init() : init, noop],
      useEffect: noop,
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (init) => ({ current: init === undefined ? null : init }),
      createContext: () => ({ Provider: noop }),
      Fragment: "Fragment",
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" },
    "@deepseek-ai/dsh-client-ui-primitives": { Button: () => null },
  };
}

/** Load the real client bundle in a fresh module realm (fresh closure state). */
function loadClient() {
  let registration = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          registration = def;
        },
      },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, chipsEnabled: false }),
    }),
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "lib/client.js" });
  if (!registration) throw new Error("client bundle did not register with __ModuleLoader__");

  const table = stubs();
  const mod = registration.factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(table, spec)) return table[spec];
    throw new Error(`unexpected require("${spec}")`);
  });
  return { id: registration.id, mod };
}

const LOCALES = [{ id: "en", label: "English" }, { id: "zh", label: "中文" }];

/**
 * Stub client cordis context.
 * @param options.active - host locale the service would report.
 * @param options.service - "direct" | "late" | "none": is `locale` readable now,
 *   only through `ctx.inject`, or unreachable at all.
 * @param options.localeThrows - service present but `getLocale()` throws.
 * @param options.injectThrows - `ctx.inject` exists but throws when called.
 */
function makeCtx(options = {}) {
  const { active = "en", service = "direct", localeThrows = false, injectThrows = false } = options;
  const calls = { inject: [], on: [], registered: [] };
  const snapshot = () => {
    if (localeThrows) throw new Error("locale service exploded");
    return { active, locales: LOCALES, revision: 1 };
  };

  const ctx = {
    workspaces: { list: null },
    sessions: {},
    slots: {
      inject: (_key, body) => body(),
      register: (entry) => {
        calls.registered.push(entry);
        return { dispose() {} };
      },
    },
    on: (name, fn) => {
      calls.on.push({ name, fn });
    },
  };
  if (service === "direct") ctx.locale = { getLocale: snapshot };
  if (service !== "none") {
    ctx.inject = (deps, cb) => {
      calls.inject.push(deps);
      if (injectThrows) throw new Error("inject unsupported");
      cb({ locale: { getLocale: snapshot } });
    };
  }
  return { ctx, calls };
}

/** apply() schedules a status fetch; let that microtask settle before asserting. */
async function applyAndSettle(mod, ctx) {
  mod.apply(ctx);
  await new Promise((resolve) => setImmediate(resolve));
}

/** The Settings section label is the one rendered copy apply() exposes. */
function sectionLabel(calls) {
  const entry = calls.registered.find((row) => row && row.id === "dsh-trivium");
  return entry && typeof entry.label === "function" ? entry.label() : null;
}

try {
  // --- static shape -------------------------------------------------------
  {
    const { id, mod } = loadClient();
    assert(id === "dsh-trivium", "bundle registers under the plugin id");
    assert(
      JSON.stringify(mod.inject) === JSON.stringify(["slots", "sessions", "workspaces"]),
      "locale stays an injected (not declared) dependency, so a host without it still loads",
    );
    assert(mod.__locale && mod.__locale.FALLBACK_UI_LOCALE === "en", "plugin fallback is en, matching the host");
    assert(typeof mod.apply === "function", "apply is exported");
  }

  // --- pure resolution ----------------------------------------------------
  {
    const { mod } = loadClient();
    const L = mod.__locale;
    assert(L.snapshot().uiLocale === "en", "a fresh bundle starts in English, not Chinese");

    const cases = [
      ["en-US", "en"],
      ["EN", "en"],
      ["zh-CN", "zh"],
      ["ZH", "zh"],
      ["ru", "en"],
      ["ja-JP", "en"],
      ["", ""],
      [null, ""],
      [undefined, ""],
    ];
    let ok = true;
    for (const [input, want] of cases) {
      if (L.normalizeLocale(input) !== want) {
        ok = false;
        console.error(`     normalizeLocale(${JSON.stringify(input)}) !== ${JSON.stringify(want)}`);
      }
    }
    assert(ok, "normalizeLocale: only zh* is Chinese; every other resolved language falls to English");

    L.setHostLocale("zh");
    assert(L.snapshot().uiLocale === "zh", "host zh is followed");
    L.setHostLocale("ru");
    assert(L.snapshot().uiLocale === "en", "an unregistered host language never lands on Chinese");
    L.setHostLocale("zh");

    L.setPluginLocalePref("en");
    assert(L.snapshot().uiLocale === "en", "an explicit English choice outranks a Chinese host");
    L.setPluginLocalePref("zh");
    assert(L.snapshot().uiLocale === "zh", "an explicit Chinese choice outranks an English host");
    L.setPluginLocalePref("nonsense");
    assert(L.snapshot().uiLocale === "zh", "a dirty preference degrades to follow-host");
    L.setPluginLocalePref("zh");
    assert(L.resolvedUiLocale() === "zh", "resolved locale honours the stored preference");
  }

  // --- apply(): host already readable --------------------------------------
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "zh", service: "direct" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().uiLocale === "zh", "apply follows a directly readable zh host");
    assert(calls.inject.some((deps) => Array.isArray(deps) && deps[0] === "locale"), "apply also waits on ctx.inject([\"locale\"])");
    assert(sectionLabel(calls) === "Trivium 记忆", "the settings section renders Chinese under a zh host");
  }
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "en", service: "direct" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().uiLocale === "en", "apply follows a directly readable en host");
    assert(sectionLabel(calls) === "Trivium memory", "the settings section renders English under an en host");
  }

  // --- apply(): service arrives late (the issue #2 case) --------------------
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "en", service: "late" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().hostLocale === "en", "the late locale service is actually read, not silently defaulted");
    assert(mod.__locale.snapshot().uiLocale === "en", "a late-arriving locale service still switches to English");
    assert(sectionLabel(calls) === "Trivium memory", "issue #2: English host no longer renders a Chinese card");
  }
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "zh", service: "late" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().uiLocale === "zh", "a late-arriving zh service is followed too");
    assert(sectionLabel(calls) === "Trivium 记忆", "a late zh host still renders the Chinese card");
  }

  // --- apply(): the reported case — browser names no registered language ----
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "ru", service: "late" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().hostLocale === "en", "a ru host is read and mapped to English");
    assert(mod.__locale.snapshot().uiLocale === "en", "host resolving to ru shows English, not Chinese");
    assert(sectionLabel(calls) === "Trivium memory", "the reader least likely to read Chinese gets English");
  }

  // --- apply(): degraded hosts never break the plugin -----------------------
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ service: "none" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().hostLocale === "", "no locale service leaves the host language unread");
    assert(mod.__locale.snapshot().uiLocale === "en", "no locale service at all falls back to English");
    assert(sectionLabel(calls) === "Trivium memory", "the card still registers without any locale service");
  }
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ service: "direct", localeThrows: true });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().uiLocale === "en", "a throwing getLocale() does not break apply");
    assert(sectionLabel(calls) === "Trivium memory", "the card still registers after a locale read throw");
  }
  {
    const { mod } = loadClient();
    const { ctx } = makeCtx({ service: "direct", injectThrows: true });
    let threw = null;
    try {
      await applyAndSettle(mod, ctx);
    } catch (err) {
      threw = err;
    }
    assert(threw === null, "a ctx.inject that throws is swallowed");
  }

  // --- locale/change still wins after apply ---------------------------------
  {
    const { mod } = loadClient();
    const { ctx, calls } = makeCtx({ active: "en", service: "direct" });
    await applyAndSettle(mod, ctx);
    const change = calls.on.find((row) => row.name === "locale/change");
    assert(!!change, "apply subscribes to locale/change");
    if (change) {
      change.fn({ active: "zh", locales: LOCALES, revision: 2 });
      assert(mod.__locale.snapshot().uiLocale === "zh", "switching the host language updates the plugin live");
    }
  }

  // --- an explicit preference survives apply ---------------------------------
  {
    const { mod } = loadClient();
    mod.__locale.setPluginLocalePref("zh");
    const { ctx, calls } = makeCtx({ active: "en", service: "direct" });
    await applyAndSettle(mod, ctx);
    assert(mod.__locale.snapshot().uiLocale === "zh", "a stored Chinese preference is not overwritten by apply");
    assert(sectionLabel(calls) === "Trivium 记忆", "the stored preference drives the rendered card");
  }
} catch (err) {
  failed += 1;
  console.error("FAIL unexpected throw: " + (err && err.stack ? err.stack : err));
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p13 ok");
