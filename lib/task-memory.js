import {createHash,randomBytes} from 'node:crypto';
import {isScopedFollowup,scopedPackEvidence,searchEntity,validateEntitySearch} from './entity-search.js';
import {SCOPED_TOOL_HEADER,scopedToolGroups} from './memory-pack.js';
import {estimateTokens} from './tokens.js';

const RESERVE_TOKENS = 55;
const MAX_RECEIPTS = 128;
const RECEIPT_TTL = 5 * 60_000;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{12}$/;
const RESTART = 'Memory cursor expired or belongs to another task. Run ctx_find without since.';
const FOLLOWUP_RESTART = 'Prior scoped evidence is unavailable. Run ctx_find with an explicit query and entity.';

export function scopedToolRequest(args, topK) {
  const followupCursor = args.followup_cursor;
  if (args.entity_id === undefined && args.entity_name === undefined && args.pack_tokens === undefined && args.since === undefined && followupCursor === undefined) return null;
  const budget = args.pack_tokens ?? 300;
  if (!Number.isSafeInteger(budget) || budget < 96 || budget > 1200) throw new Error('pack_tokens must be 96..1200.');
  for (const cursor of [args.since,followupCursor]) {
    if (cursor !== undefined && (typeof cursor !== 'string' || !RECEIPT_PATTERN.test(cursor))) throw new Error('Invalid memory cursor.');
  }
  if (args.since !== undefined && followupCursor !== undefined) throw new Error('Choose either since or followup_cursor.');
  if (args.include_stale === true) throw new Error('Entity memory packs contain current facts only.');
  const selector = args.entity_name === undefined ? {entityId: args.entity_id} : {entityName: args.entity_name,
    ...(args.entity_id !== undefined ? {entityId: args.entity_id} : {})};
  return {budget,since:args.since,followupCursor,query:validateEntitySearch({...selector,query:args.query,limit:topK,packTokens:budget-RESERVE_TOKENS})};
}

export function createTaskMemoryReader({now = Date.now} = {}) {
  const receipts = new Map();
  const dropSession = sessionId => {
    if (sessionId) for (const [cursor, receipt] of receipts) if (receipt.sessionId === sessionId) receipts.delete(cursor);
  };
  const latest = sessionId => [...receipts].findLast(([,receipt]) => receipt.sessionId === sessionId)?.[0];
  const liveReceipt = (cursor, record, db, sessionId) => {
    const at = now();
    return !!sessionId && !!record && receipts.get(cursor) === record && record.db.deref() === db && record.sessionId === sessionId
      && at >= record.at && at - record.at < RECEIPT_TTL;
  };
  const read = async (db, {budget,query,since,followupCursor}, {sessionId='',signal,onRead} = {}) => {
    const key = JSON.stringify(query);
    const previous = since ? receipts.get(since) : null;
    if (since && (!liveReceipt(since,previous,db,sessionId) || previous.key !== key)) return RESTART;
    const evidenceCursor = followupCursor || (previous?.continued ? since : null);
    const prior = evidenceCursor ? receipts.get(evidenceCursor) : null;
    const canContinue = () => liveReceipt(evidenceCursor,prior,db,sessionId) && latest(sessionId) === evidenceCursor;
    if (evidenceCursor && (!canContinue() || !prior.evidence || prior.budget !== budget || prior.limit !== query.limit
      || !isScopedFollowup(query.query))) return FOLLOWUP_RESTART;
    let result;
    try {
      result = await searchEntity(db,query,{compactPack:true,signal,followupEvidence:prior?.evidence});
    } catch (error) {
      if (error.code === 'ENTITY_SEARCH_FOLLOWUP_STALE') return FOLLOWUP_RESTART;
      throw error;
    }
    if (evidenceCursor && !canContinue()) return FOLLOWUP_RESTART;
    if (since && (!liveReceipt(since,previous,db,sessionId) || previous.entityId !== result.entityId)) return RESTART;
    const pack = result.memoryPack, groups = scopedToolGroups(pack), selected = new Map();
    const identityChanged = previous?.aliasLine !== pack.aliasLine;
    if (previous?.aliasLine && identityChanged) return RESTART;
    for (const group of groups) {
      const fingerprint = createHash('sha256').update(JSON.stringify([group.text,group.facts])).digest('hex');
      group.ids.forEach(id => selected.set(id,fingerprint));
    }
    const changed = previous ? groups.filter(group => group.ids.some(id => previous.selected.get(id) !== selected.get(id))) : groups;
    const removed = previous ? [...previous.selected.keys()].filter(id => !selected.has(id)) : [];
    const omitted = pack.omittedIds.length ? `Budget omitted ${pack.omittedIds.length} fact(s).` : '';
    const limited = result.channels.text.truncated ? 'Hit limit reached.' : '';
    const outside = result.warnings.some(warning => warning.code === 'CURRENT_OUTSIDE_SCOPE') ? 'A replacement is outside this scope.' : '';
    const noChange = previous && !changed.length && !removed.length && !identityChanged;
    const cursor = sessionId ? noChange ? since : randomBytes(9).toString('base64url') : '';
    const header = noChange ? 'Selected scoped facts unchanged.' : !previous && !groups.length
      ? 'No scoped facts selected. Answerability not assessed.' : SCOPED_TOOL_HEADER;
    const output = [header,identityChanged ? pack.aliasLine : '',...changed.map(group => group.text),removed.length ? `No longer selected: ${removed.map(id => '#'+id).join(', ')}.` : '',
      omitted,limited,outside,cursor ? `Cursor: ${cursor}` : ''].filter(Boolean).join('\n');
    if (estimateTokens(output) > budget) return 'Scoped changes exceed the budget. Refresh without since, with a larger budget if needed.';
    if (cursor && !noChange) {
      while (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
      receipts.set(cursor,{db:new WeakRef(db),sessionId,key,entityId:result.entityId,selected,aliasLine:pack.aliasLine,
        budget,limit:query.limit,evidence:scopedPackEvidence(result),continued:!!evidenceCursor,at:now()});
    }
    onRead?.(output, changed.flatMap(group => group.facts));
    return output;
  };
  return {read,dropSession};
}
