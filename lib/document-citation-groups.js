const sourceIdOk=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!/[\x00-\x1f]/.test(id);
const UTF8=new TextEncoder();

/** Presentation only. Matching citations never erase separate facts or statuses. */
export function groupDocumentEvidenceLinks(links) {
  const groups=[], byReference=new Map();
  for(const link of links) {
    const {sourceId,reference,quote}=link;
    const valid=sourceIdOk(sourceId)&&typeof reference?.document_id==='string'&&typeof reference?.revision==='string'
      &&Number.isSafeInteger(reference?.start_byte)&&Number.isSafeInteger(reference?.end_byte)&&reference.start_byte>=0
      &&reference.end_byte>reference.start_byte&&typeof quote==='string'&&UTF8.encode(quote).length===reference.end_byte-reference.start_byte;
    const key=valid?JSON.stringify([sourceId,reference.document_id,reference.revision,reference.start_byte,reference.end_byte,quote]):null;
    if(key!==null && byReference.has(key)) {byReference.get(key).links.push(link);continue;}
    const group={sourceId,reference,quote,identity:key,links:[link]}; groups.push(group);
    if(key!==null) byReference.set(key,group);
  }
  return groups;
}
