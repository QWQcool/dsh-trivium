/** Conservative, source-grounded fixture scoring. Paraphrases require manual review. */
const normalize = (s) => String(s || '').replace(/\s+/g,'').replace(/^(?:记住[：:,，]?|先记三条约定[：:,，]?)/,'').replace(/[。；;]+$/,'');
export function scoreExtraction(candidates, facts) {
  const gold = new Map(facts.map((f,i)=>[normalize(f),i]));
  const seen = new Set(), unsupported = [], duplicates = [];
  for (const c of candidates || []) {
    // Quote/name/URI cannot supply an answer absent from the actual stored body.
    if (!['decision','preference'].includes(c.type) || typeof c.text !== 'string') { unsupported.push(c); continue; }
    const units = c.text.split(/[。；;\n]+/).map(normalize).filter(Boolean);
    if (!units.length) { unsupported.push(c); continue; }
    for (const unit of units) {
      const id = gold.get(unit);
      if (id === undefined) unsupported.push({ text:unit, type:c.type });
      else if (seen.has(id)) duplicates.push(id);
      else seen.add(id);
    }
  }
  const missing = facts.map((_,i)=>i).filter(i=>!seen.has(i));
  return { rubric:'source-grounded-v1', matched:[...seen].sort(), missing, unsupported, duplicates,
    pass: missing.length===0 && unsupported.length===0 && duplicates.length===0,
    needsSemanticReview: unsupported.length>0 };
}
