/**
 * DSH 0.2.x host adaptation.
 *
 * Session format v4 (DSH 0.2.0+) replaced the shared `kind: "plugin"` message
 * source with producer-owned kinds (`plugin:dsh-trivium`, no `plugin` field);
 * writing the old shape into a v4 log fails the whole turn. 0.1.x still wants
 * the old shape, so the plugin switches on the installed dsh-llm version.
 *
 * The wire helper lives in lib/host-format.js with no @deepseek-ai imports, so
 * this script runs under plain `npm test`; apply() itself needs a full host
 * coordinator, so the event wiring is pinned at the source level.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectHostFormatV4, producerSourceFor } from "../lib/host-format.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  const versions = [
    ["0.1.0-rc.8", false],
    ["0.1.1-rc.2", false],
    ["0.1.5-rc.1", false],
    ["0.1.6", false],
    ["0.2.0-rc.2", true],
    ["0.2.1-rc.2", true],
    ["1.0.0", true],
    ["", true],
    [undefined, true],
    [null, true],
  ];
  let ok = true;
  for (const [input, want] of versions) {
    const got = detectHostFormatV4(input);
    if (got !== want) {
      ok = false;
      console.error(`     detectHostFormatV4(${JSON.stringify(input)}) = ${got}, want ${want}`);
    }
  }
  assert(ok, "format switch: v4 starts at 0.2.0; an unreadable version assumes the current format");

  const v4 = producerSourceFor(true, { form: "recall", sections: [] });
  assert(v4.kind === "plugin:dsh-trivium", "v4 source uses the producer-owned kind");
  assert(!Object.prototype.hasOwnProperty.call(v4, "plugin"), "v4 source drops the plugin field");
  assert(v4.form === "recall" && Array.isArray(v4.sections), "v4 source keeps extra fields");

  const legacy = producerSourceFor(false, { form: "snapshot" });
  assert(legacy.kind === "plugin", "0.1.x source keeps the shared kind");
  assert(legacy.plugin === "dsh-trivium", "0.1.x source carries the plugin name");
  assert(legacy.form === "snapshot", "0.1.x source keeps extra fields");

  const extra = { form: "recall" };
  producerSourceFor(true, extra);
  assert(!("kind" in extra), "producerSourceFor does not mutate the extra fields");

  // apply() needs a coordinator; pin the wiring without booting a host.
  const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  assert(/ctx\.on\("agent\/created"/.test(src), "registers agent/created (DSH 0.1.6+)");
  assert(/ctx\.on\("agent\/session-start"/.test(src), "keeps agent/session-start for older hosts");
  assert(/started\.has\(startId\)/.test(src), "guards against a host emitting both start events");
  assert(!/kind:\s*"plugin",\s*\n?\s*plugin:/.test(src), "no message source bypasses the format helper");

  // Live check only when the peer exists; a clean checkout still runs the rest.
  const hostPkgPath = join(ROOT, "node_modules", "@deepseek-ai", "dsh-llm", "package.json");
  if (existsSync(hostPkgPath)) {
    const hostVersion = JSON.parse(readFileSync(hostPkgPath, "utf8")).version;
    const mod = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);
    assert(
      mod.HOST_FORMAT_V4 === detectHostFormatV4(hostVersion),
      `live switch matches the installed host ${hostVersion}`,
    );
    const live = mod.producerSource({ form: "snapshot" });
    assert(
      live.kind === (mod.HOST_FORMAT_V4 ? "plugin:dsh-trivium" : "plugin"),
      "producerSource follows the live switch",
    );
  } else {
    console.log("skip live index.js check: @deepseek-ai/dsh-llm is not installed");
  }
} catch (err) {
  failed += 1;
  console.error("FAIL unexpected throw: " + (err && err.stack ? err.stack : err));
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p14 ok");
