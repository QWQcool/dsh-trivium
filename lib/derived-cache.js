/** Process-local derived data only. A new handle or any native mutation invalidates it. */
const states=new WeakMap();
const mutations=['insert','insertWithId','batchInsert','batchInsertWithIds','updatePayload','updateVector','updateEdge','delete','deleteManyAtomic',
  'link','unlink','upsertEdge','commitTransaction','tqlMut','indexText','indexKeyword','removeText','removeKeyword','buildTextIndex','rebuildTextIndex',
  'documentRequest','graphRequest','consoleRequest','close','dispose','closeTimeout','requestShutdown'];
const readDocumentOps=new Set(['get','resolve','search','search_vector','search_hybrid','context','parse','upload_status','list_uploads']);
function mutates(name,args) {
  if(name!=='documentRequest')return true;
  try{return !readDocumentOps.has(JSON.parse(args[0]).operation);}catch{return true;}
}
export function trackDatabaseWrites(db) {
  if(states.has(db))return db;
  const state={epoch:0,entries:new Map(),bytes:0,hits:0,misses:0,invalidations:0,closed:false};
  // Installation is all-or-nothing for cache eligibility. A read-only/frozen
  // dependency which cannot be observed continues through the uncached path.
  try {
    for(const name of mutations) {
      const original=db[name];if(typeof original!=='function')continue;
      const wrapped=function(...args) {
        const changed=mutates(name,args);
        if(changed){state.epoch++;state.invalidations++;state.entries.clear();state.bytes=0;}
        const result=original.apply(db,args);
        if(['close','dispose'].includes(name)||name==='closeTimeout'&&result===true)state.closed=true;
        return result;
      };
      // SDK dispose is an inherited non-writable alias. An own descriptor
      // safely shadows it without mutating the shared native prototype.
      Object.defineProperty(db,name,{value:wrapped,writable:true,configurable:true});
    }
    states.set(db,state);
  } catch { /* Unknown handles are never cached. */ }
  return db;
}
export function readDerived(db,key,{now=Date.now()}={}) {
  const state=states.get(db);
  if(!state||state.closed)return {hit:false};
  const entry=state.entries.get(key);
  if(!entry||entry.epoch!==state.epoch||entry.expiresAt<=now||now<entry.createdAt){
    state.misses++;
    if(entry){state.entries.delete(key);state.bytes-=entry.bytes;}
    return {hit:false};
  }
  state.hits++;state.entries.delete(key);state.entries.set(key,entry);
  return {hit:true,value:structuredClone(entry.value)};
}
export function writeDerived(db,key,value,{expiresAt=Date.now()+60000,now=Date.now()}={}) {
  const state=states.get(db);
  if(!state||state.closed||!Number.isFinite(expiresAt)||expiresAt<=now)return;
  const bytes=Buffer.byteLength(JSON.stringify(value),'utf8');
  if(bytes>512*1024)return;
  const previous=state.entries.get(key);if(previous){state.bytes-=previous.bytes;state.entries.delete(key);}
  while(state.entries.size>=64||state.bytes+bytes>2*1024*1024){
    const oldest=state.entries.keys().next().value;state.bytes-=state.entries.get(oldest).bytes;state.entries.delete(oldest);
  }
  state.entries.set(key,{value:structuredClone(value),bytes,epoch:state.epoch,createdAt:now,expiresAt:Math.min(expiresAt,now+60000)});state.bytes+=bytes;
}
export function derivedCacheStats(db) {
  const s=states.get(db);return s?{enabled:!s.closed,entries:s.entries.size,bytes:s.bytes,hits:s.hits,misses:s.misses,invalidations:s.invalidations,epoch:s.epoch}
    :{enabled:false,entries:0,bytes:0,hits:0,misses:0,invalidations:0,epoch:null};
}
