import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readPrivateJSON,saveSnapshot,decryptSnapshot,digest} from '../scripts/backups.mjs';

const PLAIN_LIMIT=32*1024*1024,ENVELOPE_LIMIT=44*1024*1024;
async function temporary(run){const directory=await mkdtemp(path.join(tmpdir(),'liubai-limits-proposal-'));try{return await run(directory)}finally{await rm(directory,{recursive:true,force:true})}}
function snapshot(entryCount,bodyLength){
 const owner='synthetic-limit-test',body='x'.repeat(bodyLength);
 const tables={tasks:[],spaces:[],inbox_entries:Array.from({length:entryCount},(_,i)=>({owner,id:'synthetic-'+i,body,state:'pending',summary:'',plan_token:null,created_at:'2026-10-08T00:00:00Z',processed_at:null})),task_changes:[],organizer_profiles:[],task_imports:[]};
 return {format:'liubai-snapshot',version:1,accountKey:digest('liubai-account-v1:'+owner),tables,counts:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length])),hashAlgorithm:'sha256-canonical-json-v1',snapshotHash:digest(tables),businessHash:digest(tables)};
}
test('JSON reader uses the explicit byte boundary including multibyte characters',()=>temporary(async directory=>{
 const value={text:'中'.repeat(80)},encoded=JSON.stringify(value),bytes=Buffer.byteLength(encoded),file=path.join(directory,'synthetic.json');
 await writeFile(file,encoded,{mode:0o600});await chmod(file,0o600);
 assert.deepEqual(await readPrivateJSON(file,{maxBytes:bytes}),value);
 await assert.rejects(()=>readPrivateJSON(file,{maxBytes:bytes-1}),/大小限制/);
}));
test('small verified backup still writes and unchanged content skips',()=>temporary(async directory=>{
 const key=randomBytes(32).toString('base64'),source='https://liubai.example',plain=snapshot(1,80);
 const saved=await saveSnapshot(plain,{directory,key,source});assert.equal(saved.changed,true);
 assert.deepEqual(decryptSnapshot(await readPrivateJSON(saved.file,{maxBytes:ENVELOPE_LIMIT}),key),plain);
 assert.equal((await saveSnapshot(plain,{directory,key,source})).changed,false);
}));
test('legal 26 MiB full snapshot survives base64 expansion; over-limit plaintext leaves no new backup',{
 skip:process.env.LIUBAI_LARGE_SNAPSHOT_TEST!=='1',
},()=>temporary(async directory=>{
 const key=randomBytes(32).toString('base64'),source='https://liubai.example',plain=snapshot(1300,20000);
 assert.ok(Buffer.byteLength(JSON.stringify(plain))<PLAIN_LIMIT);
 const saved=await saveSnapshot(plain,{directory,key,source});assert.equal(saved.changed,true);
 const readback=decryptSnapshot(await readPrivateJSON(saved.file,{maxBytes:ENVELOPE_LIMIT}),key);
 assert.equal(readback.tables.inbox_entries.length,1300);assert.equal(readback.tables.inbox_entries[1299].body.length,20000);
 assert.equal((await saveSnapshot(plain,{directory,key,source})).changed,false);
 const oversized=snapshot(1700,20000);assert.ok(Buffer.byteLength(JSON.stringify(oversized))>PLAIN_LIMIT);
 const accountFolder=path.dirname(saved.file),before=(await readdir(accountFolder)).filter(name=>name.endsWith('.json.enc'));
 await assert.rejects(()=>saveSnapshot(oversized,{directory,key,source}),/大小|上限|过长/);
 assert.deepEqual((await readdir(accountFolder)).filter(name=>name.endsWith('.json.enc')),before);
}));
