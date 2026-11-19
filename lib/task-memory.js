import {createHash,randomBytes} from 'node:crypto';
import {searchEntity,validateEntitySearch} from './entity-search.js';
import {SCOPED_TOOL_HEADER,scopedToolGroups} from './memory-pack.js';
import {estimateTokens} from './tokens.js';

const RESERVE_TOKENS = 55;
const MAX_RECEIPTS = 128;
const RECEIPT_TTL = 5 * 60_000;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{12}$/;
const RESTART = 'Memory cursor expired or belongs to another task. Run ctx_find without since.';

export function scopedToolRequest(args, topK) {
  if (args.entity_id === undefined && args.entity_name === undefined && args.pack_tokens === undefined && args.since === undefined) return null;
  const budget = args.pack_tokens ?? 300;
  if (!Number.isSafeInteger(budget) || budget < 96 || budget > 1200) throw new Error('pack_tokens must be 96..1200.');
  if (args.since !== undefined && (typeof args.since !== 'string' || !RECEIPT_PATTERN.test(args.since))) throw new Error('Invalid memory cursor.');
  if (args.include_stale === true) throw new Error('Entity memory packs contain current facts only.');
  const selector = args.entity_name === undefined ? {entityId: args.entity_id} : {entityName: args.entity_name,
    ...(args.entity_id !== undefined ? {entityId: args.entity_id} : {})};
  return {budget,since:args.since,query:validateEntitySearch({...selector,query:args.query,limit:topK,packTokens:budget-RESERVE_TOKENS})};
}

export function createTaskMemoryReader({now = Date.now} = {}) {
  const receipts = new Map();
  const dropSession = sessionId => {
    if (sessionId) for (const [cursor, receipt] of receipts) if (receipt.sessionId === sessionId) receipts.delete(cursor);
  };
  const read = async (db, {budget,query,since}, {sessionId='',signal} = {}) => {
    const key = JSON.stringify(query);
    const previous = since ? receipts.get(since) : null;
    if (since && (!sessionId || !previous || previous.db.deref() !== db || previous.sessionId !== sessionId
      || previous.key !== key || now() < previous.at || now() - previous.at >= RECEIPT_TTL)) return RESTART;
    const result = await searchEntity(db,query,{compactPack:true,signal});
    if (since && (receipts.get(since) !== previous || now() - previous.at >= RECEIPT_TTL || previous.entityId !== result.entityId)) return RESTART;
    const pack = result.memoryPack, groups = scopedToolGroups(pack), selected = new Map();
    for (const group of groups) {
      const fingerprint = createHash('sha256').update(JSON.stringify([group.text,group.facts])).digest('hex');
      group.ids.forEach(id => selected.set(id,fingerprint));
    }
    const changed = previous ? groups.filter(group => group.ids.some(id => previous.selected.get(id) !== selected.get(id))) : groups;
    const removed = previous ? [...previous.selected.keys()].filter(id => !selected.has(id)) : [];
    const omitted = pack.omittedIds.length ? `Budget omitted ${pack.omittedIds.length} fact(s).` : '';
    const limited = result.channels.text.truncated ? 'Hit limit reached.' : '';
    const outside = result.warnings.some(warning => warning.code === 'CURRENT_OUTSIDE_SCOPE') ? 'A replacement is outside this scope.' : '';
    const noChange = previous && !changed.length && !removed.length;
    const cursor = sessionId ? noChange ? since : randomBytes(9).toString('base64url') : '';
    const header = noChange ? 'Selected scoped facts unchanged.' : !previous && !groups.length
      ? 'No scoped facts selected. Answerability not assessed.' : SCOPED_TOOL_HEADER;
    const output = [header,...changed.map(group => group.text),removed.length ? `No longer selected: ${removed.map(id => '#'+id).join(', ')}.` : '',
      omitted,limited,outside,cursor ? `Cursor: ${cursor}` : ''].filter(Boolean).join('\n');
    if (estimateTokens(output) > budget) return 'Scoped changes exceed the budget. Refresh without since, with a larger budget if needed.';
    if (cursor && !noChange) {
      while (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
      receipts.set(cursor,{db:new WeakRef(db),sessionId,key,entityId:result.entityId,selected,at:now()});
    }
    return output;
  };
  return {read,dropSession};
}
