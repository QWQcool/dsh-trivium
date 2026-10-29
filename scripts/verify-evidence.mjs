/** Read-only validation. Never regenerate evidence to make a failing hash pass. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertInside } from './experiment-support.mjs';
const manifestPath=resolve(process.argv[2]||'docs/evidence/manifest.json');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
for(const file of manifest.files){
  assert.ok(file.sha256&&!file.missing&&!file.error,`Missing evidence ${file.name}`);
  const path=assertInside(dirname(manifestPath),resolve(dirname(manifestPath),file.name));
  const bytes=readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name);
  if(file.bytes!==undefined)assert.equal(bytes.length,file.bytes,file.name);
}
console.log(`${manifest.files.length}/${manifest.files.length} evidence files verified (read-only)`);
