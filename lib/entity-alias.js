import { sanitizeForWrite } from './hygiene.js';

export const normalizeEntityName = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
export const longEnoughEntityName = name => name.length >= 3 || /^[\p{Script=Han}]{2}$/u.test(name);

export function queryMentionsEntityName(queryLower, nameLower) {
  if (!queryLower || !nameLower || !longEnoughEntityName(nameLower)) return false;
  if (queryLower === nameLower) return true;
  if (/^[\x00-\x7f]+$/.test(nameLower)) {
    const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(queryLower);
  }
  return queryLower.includes(nameLower);
}

/** Match stored labels only. Render identity separately from citable facts. */
export function entityAliasLine(id, payload, matches) {
  const safeLabel = value => typeof value === 'string' && value.length <= 160
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && sanitizeForWrite(value).ok;
  if (payload?.type !== 'entity' || !safeLabel(payload.name) || matches(normalizeEntityName(payload.name))) return '';
  const alias = (Array.isArray(payload.aliases) ? payload.aliases : []).find(value =>
    safeLabel(value) && matches(normalizeEntityName(value)));
  return alias ? `Stored entity alias (identity only): #${id} ${JSON.stringify(payload.name)} is also called ${JSON.stringify(alias)}.` : '';
}
