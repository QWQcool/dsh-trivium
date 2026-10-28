/**
 * Read-only integrity check for decision revision relations.
 *
 * This module never writes: it walks the in-memory graph and reports what is
 * inconsistent. It deliberately does not repair anything — a chain that was
 * damaged by an old import has to be restored from a backup or an export, and
 * guessing a repair would invent history.
 */

import { EDGE_LABELS, REVISION_WALK_LIMIT } from "./schema.js";

const SUPERSEDES = EDGE_LABELS.supersedes;

function edgeTargetOf(edge) {
  const raw = edge?.targetId ?? edge?.target_id ?? edge?.target ?? edge?.dst;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/**
 * @returns {{ok:boolean, nodes:number, edges:number, issues:Array<object>}}
 */
export function checkRevisionIntegrity(db) {
  const ids = (db.allNodeIds?.() || []).map(Number).filter((id) => Number.isFinite(id));
  const idSet = new Set(ids);
  const payloads = new Map();
  const out = new Map();
  const inn = new Map();
  const uris = new Map();
  const pairs = new Set();
  const issues = [];

  for (const id of ids) {
    const node = db.get(id);
    const payload = node?.payload || {};
    payloads.set(id, payload);
    const uri = String(payload.uri || "").trim();
    if (uri) {
      if (!uris.has(uri)) uris.set(uri, []);
      uris.get(uri).push(id);
    }
    for (const edge of node?.edges || []) {
      if (String(edge.label) !== SUPERSEDES) continue;
      const to = edgeTargetOf(edge);
      if (to === null) {
        issues.push({ code: "missing-endpoint", id });
        continue;
      }
      if (to === id) issues.push({ code: "self-loop", id });
      const pair = `${id}\u0000${to}`;
      if (pairs.has(pair)) issues.push({ code: "duplicate-edge", id, to });
      pairs.add(pair);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(to);
      if (!inn.has(to)) inn.set(to, []);
      inn.get(to).push(id);
    }
  }

  for (const [uri, owners] of uris) {
    if (owners.length > 1) issues.push({ code: "duplicate-uri", uri, ids: owners });
  }

  const checkEndpoint = (id) => {
    if (!idSet.has(id)) {
      issues.push({ code: "missing-node", id });
      return;
    }
    const payload = payloads.get(id) || {};
    if (payload.type !== "decision") issues.push({ code: "non-decision", id, type: payload.type || "" });
    if (payload.status === "archived") issues.push({ code: "archived-endpoint", id });
  };

  for (const [id, targets] of out) {
    checkEndpoint(id);
    if (targets.length > 1) issues.push({ code: "fork-successor", id, to: targets });
    for (const to of targets) {
      checkEndpoint(to);
      if (!idSet.has(to)) issues.push({ code: "dangling-edge", id, to });
    }
  }
  for (const [id, sources] of inn) {
    if (sources.length > 1) issues.push({ code: "fork-predecessor", id, from: sources });
  }

  // Follow each chain once from its head(s). A fork stops the walk; a repeated
  // node is a cycle; more than the walk limit is reported as too-long.
  for (const start of out.keys()) {
    const seen = new Set();
    let current = start;
    let hops = 0;
    while (out.has(current)) {
      if (seen.has(current)) {
        issues.push({ code: "cycle", id: current });
        break;
      }
      seen.add(current);
      // Follow the first edge even when the node forks: a fork is reported on
      // its own, but a cycle behind the fork must still be visible here.
      current = out.get(current)[0];
      hops += 1;
      if (hops > REVISION_WALK_LIMIT) {
        issues.push({ code: "too-long", id: start, hops });
        break;
      }
    }
  }

  const unique = [];
  const seenIssue = new Set();
  for (const issue of issues) {
    const key = JSON.stringify(issue);
    if (seenIssue.has(key)) continue;
    seenIssue.add(key);
    unique.push(issue);
  }

  return {
    ok: unique.length === 0,
    nodes: ids.length,
    edges: pairs.size,
    issues: unique,
  };
}
