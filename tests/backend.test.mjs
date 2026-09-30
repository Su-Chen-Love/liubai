import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// Exercise the production services against actual SQLite transactions, replacing
// only the Cloudflare binding. No user database, network or stored token is used.
const root=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(join(tmpdir(),'liubai-backend-'));
const bundle=await build({stdin:{contents:"export * from './lib/organizer-service'; export * from './lib/agent-service'; export * from './lib/snapshot'; export * from './lib/organizer'; export * from './lib/account'; export * from './lib/import-service';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node22',write:false,plugins:[{name:'test-d1',setup(build){build.onLoad({filter:/\/lib\/database\.ts$/},()=>({contents:'export function database(){return globalThis.__liubaiTestDB}',loader:'js'}))}}]});
await writeFile(join(temporary,'services.mjs'),bundle.outputFiles[0].contents);
const api=await import(pathToFileURL(join(temporary,'services.mjs')).href);
let sqlite,preBatch;
class Statement {
 constructor(sql,values=[]){this.sql=sql;this.values=values}
 bind(...values){return new Statement(this.sql,values)}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.values),meta:{changes:0}}}
 async first(){return sqlite.prepare(this.sql).get(...this.values)??null}
 async run(){const r=sqlite.prepare(this.sql).run(...this.values);return {results:[],meta:{changes:Number(r.changes)}}}
 execute(){const s=sqlite.prepare(this.sql);if(s.columns().length)return {results:s.all(...this.values),meta:{changes:0}};const r=s.run(...this.values);return {results:[],meta:{changes:Number(r.changes)}}}
}
const migrations=(await readdir(join(root,'drizzle'))).filter(n=>n.endsWith('.sql')).sort();
beforeEach(async()=>{
 sqlite?.close();sqlite=new DatabaseSync(':memory:');preBatch=null;
 for(const name of migrations)sqlite.exec(await readFile(join(root,'drizzle',name),'utf8'));
 globalThis.__liubaiTestDB={prepare:sql=>new Statement(sql),async batch(statements){const hook=preBatch;preBatch=null;if(hook)hook();sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.execute());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
});
after(async()=>{sqlite?.close();await rm(temporary,{recursive:true,force:true});delete globalThis.__liubaiTestDB});
const uuid=()=>crypto.randomUUID();
const task=(overrides={})=>({id:uuid(),title:'写项目记录',note:'初稿',quadrant:1,category:'工作',due:'',done:false,subtasks:[],revision:0,...overrides});
const raw=(sql,...args)=>sqlite.prepare(sql).get(...args);
function entry(owner='alice',created='2026-09-01T01:00:00.000Z'){const id=uuid();sqlite.prepare('INSERT INTO inbox_entries(owner,id,body,created_at) VALUES(?,?,?,?)').run(owner,id,'用户原文',created);return id}
function storedTask(owner,t,deleted=0){sqlite.prepare('INSERT INTO tasks(owner,id,data,revision,deleted) VALUES(?,?,?,?,?)').run(owner,t.id,JSON.stringify(t),t.revision,deleted)}
async function authorized(owner='alice'){
 await api.ensureProfile(owner);const key=await api.accountKey(owner);await api.updateGrant(owner,key,true);
 const {job}=await api.claimJob({accountKey:key,requestId:uuid()},'a'.repeat(64));
 const auth={jobId:job.id,generation:job.generation,leaseToken:job.leaseToken};const {lease}=await api.resolveLease(auth);
 return {key,job,auth,lease};
}
function plan(entryId,t,kind='create',automatic=true){return {action:'plan',entryId,summary:'已整理用户输入',changes:[{id:uuid(),kind,task:t,reason:'原文明确要求',automatic}]}}

test('machine authorization uses a separate sha256 bearer, fails closed, and ignores identity headers',async()=>{
 const token='machine-secret-'+uuid(),hash=await api.sha256(token);
 assert.equal(await api.validMachineToken('Bearer '+token,hash),true);
 assert.equal(await api.validMachineToken('Bearer '+token,hash.toUpperCase()),true);
 for(const [header,expected] of [[null,hash],['Bearer '+token,undefined],['Bearer wrong',hash],['oai-authenticated-user-id:alice',hash],['Bearer '+token,'bad'],['Bearer '+token+' ',hash]])assert.equal(await api.validMachineToken(header,expected),false);
});

test('queue contains only grants; claims serialize accounts and retry the same lease receipt',async()=>{
 entry('ungranted');assert.deepEqual((await api.agentQueue()).accounts,[]);
 const key=await api.accountKey('alice');await api.updateGrant('alice',key,true);const requestId=uuid();
 const first=await api.claimJob({accountKey:key,requestId},'a'.repeat(64));const again=await api.claimJob({accountKey:key,requestId},'a'.repeat(64));assert.deepEqual(again,first);
 await assert.rejects(api.claimJob({accountKey:key,requestId:uuid()},'a'.repeat(64)),e=>e.code==='ACCOUNT_BUSY');
 await assert.rejects(api.claimJob({accountKey:await api.accountKey('ungranted'),requestId:uuid()},'a'.repeat(64)),e=>e.code==='GRANT_REQUIRED');
 assert.equal((await api.agentQueue()).accounts[0].leased,true);
 const key2=await api.accountKey('bob');await api.updateGrant('bob',key2,true);await api.claimJob({accountKey:key2,requestId:uuid()},'a'.repeat(64));
 assert.equal(raw("SELECT COUNT(*) AS n FROM agent_jobs WHERE state='leased'").n,2);
});

test('renew keeps the token; stale/expired generations cannot write or obtain context',async()=>{
 const {auth,job,key}=await authorized();const renewed=await api.agentAction({action:'renew',...auth},'a'.repeat(64));assert.equal(renewed.job.leaseToken,job.leaseToken);
 assert.equal(Date.parse(renewed.job.leaseUntil)>Date.now(),true);
 await assert.rejects(api.agentAction({action:'context',...auth,generation:auth.generation+1},'a'.repeat(64)),e=>e.code==='LEASE_LOST');
 sqlite.prepare("UPDATE agent_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
 await assert.rejects(api.agentAction({action:'context',...auth},'a'.repeat(64)),e=>e.code==='LEASE_LOST');
 await assert.rejects(api.claimJob({accountKey:key,requestId:raw('SELECT request_id FROM agent_jobs WHERE id=?',job.id).request_id},'a'.repeat(64)),e=>e.code==='LEASE_LOST');
 assert.equal((await api.claimJob({accountKey:key,requestId:uuid()},'a'.repeat(64))).job.state,'leased');
});

test('revocation fences a plan inside its final transaction and cannot be undone by old leases',async()=>{
 const {key,lease,auth}=await authorized(),id=entry();
 preBatch=()=>sqlite.exec("UPDATE organizer_grants SET enabled=0,generation=generation+1 WHERE owner='alice'");
 await assert.rejects(api.savePlan('alice',plan(id,task()),lease),e=>e.code==='LEASE_LOST');
 assert.equal(raw('SELECT state FROM inbox_entries WHERE owner=? AND id=?','alice',id).state,'pending');assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,0);
 assert.equal((await api.agentQueue()).accounts.length,0);
 await api.updateGrant('alice',key,true);await assert.rejects(api.resolveLease(auth),e=>e.code==='LEASE_LOST');
});

test('a persisted claim request recovers after revoke and re-enable while retaining account serialization',async()=>{
 const key=await api.accountKey('alice'),requestId=uuid();await api.updateGrant('alice',key,true);
 const first=await api.claimJob({accountKey:key,requestId},'a'.repeat(64));
 await api.updateGrant('alice',key,false);await api.updateGrant('alice',key,true);
 const recovered=await api.claimJob({accountKey:key,requestId},'a'.repeat(64));
 assert.notEqual(recovered.job.id,first.job.id);assert.ok(recovered.job.generation>first.job.generation);assert.notEqual(recovered.job.leaseToken,first.job.leaseToken);
 assert.deepEqual(await api.claimJob({accountKey:key,requestId},'a'.repeat(64)),recovered);
 await assert.rejects(api.resolveLease({jobId:first.job.id,generation:first.job.generation,leaseToken:first.job.leaseToken}),e=>e.code==='LEASE_LOST');
 await assert.rejects(api.claimJob({accountKey:key,requestId:uuid()},'a'.repeat(64)),e=>e.code==='ACCOUNT_BUSY');
 assert.equal(raw("SELECT COUNT(*) AS n FROM agent_jobs WHERE owner='alice' AND state='leased'").n,1);
});

test('frozen plans have an idempotent receipt and a second plan cannot replace or duplicate them',async()=>{
 const {lease}=await authorized(),id=entry(),t=task(),p=plan(id,t);
 const first=await api.savePlan('alice',p,lease),again=await api.savePlan('alice',plan(id,task({title:'不同的新计划'})),lease);
 assert.equal(first.alreadyProcessed,false);assert.equal(again.alreadyProcessed,true);assert.deepEqual(again.receipt,first.receipt);
 assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);assert.equal(raw('SELECT COUNT(*) AS n FROM task_changes').n,1);
 assert.equal(raw('SELECT data FROM tasks WHERE owner=? AND id=?','alice',t.id).data,JSON.stringify(t));
});

test('earlier pending input and interrupted automatic changes precede new input',async()=>{
 const {lease}=await authorized(),earlier=entry('alice','2026-09-01T00:00:00.000Z'),later=entry('alice','2026-09-02T00:00:00.000Z');
 await assert.rejects(api.savePlan('alice',plan(later,task()),lease),e=>e.code==='QUEUE_ORDER');
 await api.savePlan('alice',plan(earlier,task()),lease);
 const interrupted=task({title:'中断的新增'}),changeId=uuid();sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,created_at) VALUES(?,?,?,'create',?,'明确新增',1,?)").run('alice',changeId,earlier,JSON.stringify(interrupted),'2026-09-01T00:01:00.000Z');
 await assert.rejects(api.savePlan('alice',plan(later,task({title:'后来的任务'})),lease),e=>e.code==='QUEUE_ORDER');
 assert.deepEqual((await api.resumeAutomatic('alice',lease)).errors,[]);
 await api.savePlan('alice',plan(later,task({title:'后来的任务'})),lease);assert.equal(raw('SELECT state FROM task_changes WHERE id=?',changeId).state,'applied');
});

test('machine owner comes exclusively from its job and context never includes another account',async()=>{
 const {auth,key}=await authorized();entry('alice');entry('bob');storedTask('alice',task({title:'Alice任务'}));storedTask('bob',task({title:'Bob任务'}));
 const context=await api.agentAction({action:'context',...auth,owner:'bob',accountKey:await api.accountKey('bob')},'a'.repeat(64));
 assert.equal(context.accountKey,key);assert.deepEqual(context.tasks.map(t=>t.title),['Alice任务']);assert.equal(context.entries.length,1);
});

test('deadline/urgency/title replacement/deletion require user decisions, legacy normalization allows true append',async()=>{
 const before=task();assert.equal(api.safeAppend(before,{...before,note:'初稿\n新信息',deadline:'',urgencyMode:'manualNormal'}),true);
 for(const changed of [{deadline:'2026-10-02'},{urgencyMode:'auto'},{title:'被替换'},{quadrant:0},{due:'2026-10-02'},{done:true}])assert.equal(api.safeAppend(before,{...before,...changed}),false);
 const {lease}=await authorized();storedTask('alice',before);
 const id=entry();await api.savePlan('alice',plan(id,{...before,deadline:'2026-10-02'},'update'),lease);
 assert.equal(raw('SELECT automatic FROM task_changes WHERE entry_id=?',id).automatic,0);assert.equal(raw('SELECT revision FROM tasks WHERE id=?',before.id).revision,0);
 const append=entry('alice','2026-09-02T00:00:00.000Z');await api.savePlan('alice',plan(append,{...before,note:'初稿\n新信息'},'update'),lease);
 assert.equal(raw('SELECT revision FROM tasks WHERE id=?',before.id).revision,1);
 const del=entry('alice','2026-09-03T00:00:00.000Z');await api.savePlan('alice',plan(del,{...before,note:'初稿\n新信息',revision:1},'delete'),lease);assert.equal(raw('SELECT automatic FROM task_changes WHERE entry_id=?',del).automatic,0);assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',before.id).deleted,0);
});

test('old proposals cannot overwrite manual edits; revocation fences automatic apply at commit',async()=>{
 const {lease}=await authorized(),t=task();storedTask('alice',t);const id=entry();const p=plan(id,{...t,note:'初稿\n自动追加'},'update');
 // Freeze as a pending user proposal, then emulate an interrupted safe apply.
 p.changes[0].automatic=false;await api.savePlan('alice',p,lease);sqlite.prepare('UPDATE task_changes SET automatic=1 WHERE id=?').run(p.changes[0].id);
 sqlite.prepare('UPDATE tasks SET revision=1,data=? WHERE id=?').run(JSON.stringify({...t,title:'用户手动更改',revision:1}),t.id);
 await assert.rejects(api.applyChange('alice',p.changes[0].id,true,lease),e=>e.code==='CONFLICT');assert.equal(JSON.parse(raw('SELECT data FROM tasks WHERE id=?',t.id).data).title,'用户手动更改');
 const next=task({title:'撤销期间的新增'}),newId=uuid();sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,created_at) VALUES(?,?,?,'create',?,'明确新增',1,?)").run('alice',newId,id,JSON.stringify(next),new Date().toISOString());
 preBatch=()=>sqlite.exec("UPDATE organizer_grants SET enabled=0,generation=generation+1 WHERE owner='alice'");
 await assert.rejects(api.applyChange('alice',newId,true,lease),e=>e.code==='LEASE_LOST');assert.equal(raw('SELECT data FROM tasks WHERE id=?',next.id),undefined);
});

test('snapshot is complete, account-scoped, includes tombstones/imports, and checkins leave business hash unchanged',async()=>{
 const {lease,auth}=await authorized();
 for(let i=0;i<155;i++)entry('alice',`2026-09-01T01:${String(i%60).padStart(2,'0')}:00.000Z`);
 for(let i=0;i<405;i++){const t=task();sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,created_at) VALUES(?,?,?,'create',?,'已保留',0,?)").run('alice',uuid(),uuid(),JSON.stringify(t),new Date().toISOString());}
 storedTask('alice',task({title:'已删除'}),1);storedTask('bob',task({title:'不可读取'}));entry('bob');
 sqlite.prepare("INSERT INTO task_imports(owner,id,data,state,created_at,updated_at) VALUES(?,?,?,'preview',?,?)").run('alice',uuid(),'{}',new Date().toISOString(),new Date().toISOString());
 const snapshot=await api.createSnapshot('alice',lease);assert.equal(snapshot.counts.inbox_entries,155);assert.equal(snapshot.counts.task_changes,405);assert.equal(snapshot.counts.task_imports,1);assert.equal(snapshot.tables.tasks[0].deleted,1);
 assert.equal(Object.values(snapshot.tables).flat().every(row=>row.owner==='alice'),true);assert.equal(snapshot.snapshotHash.length,64);
 await api.organizerCheckin('alice','本轮检查');const after=await api.createSnapshot('alice',lease);assert.equal(after.businessHash,snapshot.businessHash);assert.notEqual(after.snapshotHash,snapshot.snapshotHash);
 sqlite.prepare("UPDATE organizer_grants SET backup_enabled=0 WHERE owner='alice'").run();await assert.rejects(api.createSnapshot('alice',lease),e=>e.code==='LEASE_LOST');
 assert.equal((await api.createSnapshot('alice')).counts.inbox_entries,155);
 const done=await api.agentAction({action:'checkin',...auth,result:'检查完成'},'a'.repeat(64));assert.equal(done.job.state,'complete');assert.equal((await api.agentAction({action:'checkin',...auth,result:'检查完成'},'a'.repeat(64))).alreadyFinished,true);
});

test('automatic create detects same-name manual additions in the final transaction',async()=>{
 const {lease}=await authorized(),e=entry(),t=task();const p=plan(e,t);p.changes[0].automatic=false;
 await api.savePlan('alice',p,lease);sqlite.prepare('UPDATE task_changes SET automatic=1 WHERE id=?').run(p.changes[0].id);
 preBatch=()=>storedTask('alice',task({title:t.title}));
 await assert.rejects(api.applyChange('alice',p.changes[0].id,true,lease),e=>e.code==='CONFLICT');assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);assert.equal(raw('SELECT state FROM task_changes WHERE id=?',p.changes[0].id).state,'pending');
});

test('import same-batch replay and stable source IDs across batches never insert duplicates',async()=>{
 const t=task(),sourceId='source-stable-123',batchId=uuid();
 const p=await api.previewImport('alice',{batchId,sourceId,tasks:[t]});assert.equal(p.additions.length,1);
 const first=await api.applyImport('alice',batchId);assert.deepEqual(first,{imported:1,pending:0,replayed:false});
 assert.deepEqual(await api.applyImport('alice',batchId),{imported:1,pending:0,replayed:true});
 assert.deepEqual(await api.previewImport('alice',{batchId,sourceId,tasks:[task({title:'改变原始同批次内容'})]}),p);
 const p2=await api.previewImport('alice',{batchId:uuid(),sourceId,tasks:[t]});assert.equal(p2.additions.length,0);assert.equal(p2.unchanged.length,1);
 await api.applyImport('alice',p2.id);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);
});

test('import tombstones preserve deletion, including subsequent changed source titles',async()=>{
 const t=task(),sourceId='source-stable-123',firstId=uuid();const p=await api.previewImport('alice',{batchId:firstId,sourceId,tasks:[t]});await api.applyImport('alice',firstId);
 sqlite.prepare('UPDATE tasks SET deleted=1,revision=revision+1 WHERE id=?').run(p.additions[0].task.id);
 const again=await api.previewImport('alice',{batchId:uuid(),sourceId,tasks:[{...t,title:'本地改了任务名称',note:'增加了说明'}]});assert.equal(again.unchanged.length,1);assert.equal(again.additions.length,0);assert.equal(again.duplicates.length,0);
 await api.applyImport('alice',again.id);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);assert.equal(raw('SELECT deleted FROM tasks').deleted,1);
});

test('import refuses stale preview after manual revision or an addition during the final batch',async()=>{
 const existing=task();storedTask('alice',existing);const input={batchId:uuid(),sourceId:'source-stable-123',tasks:[task({title:'要迁移的新事项'})]};await api.previewImport('alice',input);
 sqlite.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(JSON.stringify({...existing,note:'手动修改',revision:1}),existing.id);
 await assert.rejects(api.applyImport('alice',input.batchId),e=>e.status===409);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);
 const fresh={...input,batchId:uuid()};await api.previewImport('alice',fresh);preBatch=()=>storedTask('alice',task({title:'并发创建'}));
 await assert.rejects(api.applyImport('alice',fresh.batchId),e=>e.status===409);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,2);assert.equal(raw('SELECT state FROM task_imports WHERE id=?',fresh.batchId).state,'preview');
});

test('import scopes the same batch to each owner and preserves differing duplicates as user proposals',async()=>{
 const sharedId=uuid(),incoming=task({title:'同一事项',due:'2026-10-03'}),existing=task({title:'同一事项',due:''});storedTask('alice',existing);storedTask('bob',task({title:'另一账号已有事项'}));
 const a=await api.previewImport('alice',{batchId:sharedId,sourceId:'source-stable-123',tasks:[incoming]});const b=await api.previewImport('bob',{batchId:sharedId,sourceId:'source-stable-123',tasks:[incoming]});
 assert.equal(a.duplicates.length,1);assert.equal(b.additions.length,1);assert.notEqual(a.accountKey,b.accountKey);
 await api.applyImport('alice',sharedId);assert.equal(raw('SELECT revision FROM tasks WHERE owner=? AND id=?','alice',existing.id).revision,0);assert.equal(raw('SELECT data FROM tasks WHERE owner=? AND id=?','alice',existing.id).data,JSON.stringify(existing));
 const c=raw('SELECT owner,automatic,state FROM task_changes');assert.deepEqual({...c},{owner:'alice',automatic:0,state:'pending'});
 await api.applyImport('bob',sharedId);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks WHERE owner=?','bob').n,2);
 await assert.rejects(api.applyImport('mallory',sharedId),e=>e.status===404);
});
