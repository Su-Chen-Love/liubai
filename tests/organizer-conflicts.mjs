import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(join(ROOT,'package.json')),{build}=require('esbuild');
const temporary=await mkdtemp(join(tmpdir(),'liubai-organizer-proposal-'));
const bundle=await build({stdin:{contents:"export * from './lib/organizer-service'; export * from './lib/agent-service'; export * from './lib/snapshot'; export * from './lib/organizer'; export * from './lib/account';",resolveDir:ROOT,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node22',write:false,plugins:[{name:'isolated-d1',setup(b){b.onLoad({filter:/\/lib\/database\.ts$/},()=>({contents:'export function database(){return globalThis.__liubaiOrganizerProposalDB}',loader:'js'}))}}]});
await writeFile(join(temporary,'services.mjs'),bundle.outputFiles[0].contents);
const api=await import(pathToFileURL(join(temporary,'services.mjs')).href);
const migrationSQL=await Promise.all((await readdir(join(ROOT,'drizzle'))).filter(n=>n.endsWith('.sql')).sort().map(n=>readFile(join(ROOT,'drizzle',n),'utf8')));
let sqlite,preBatch;
class Statement {
 constructor(sql,values=[]){this.sql=sql;this.values=values}
 bind(...values){return new Statement(this.sql,values)}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.values),meta:{changes:0}}}
 async first(){return sqlite.prepare(this.sql).get(...this.values)??null}
 async run(){return this.execute()}
 execute(){const s=sqlite.prepare(this.sql);if(s.columns().length)return {results:s.all(...this.values),meta:{changes:0}};return {results:[],meta:{changes:Number(s.run(...this.values).changes)}}}
}
beforeEach(()=>{
 sqlite?.close();sqlite=new DatabaseSync(':memory:');preBatch=null;for(const sql of migrationSQL)sqlite.exec(sql);
 globalThis.__liubaiOrganizerProposalDB={prepare:sql=>new Statement(sql),async batch(statements){const hook=preBatch;preBatch=null;if(hook)hook();sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.execute());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
});
after(async()=>{sqlite?.close();delete globalThis.__liubaiOrganizerProposalDB;await rm(temporary,{recursive:true,force:true})});
const task=(overrides={})=>({id:crypto.randomUUID(),title:'Synthetic task',note:'Initial note',quadrant:1,category:'工作',due:'',deadline:'',urgencyMode:'manualNormal',done:false,subtasks:[],revision:0,...overrides});
const raw=(sql,...values)=>sqlite.prepare(sql).get(...values);
function entry(owner='alice',created='2026-09-01T00:00:00.000Z'){const id=crypto.randomUUID();sqlite.prepare('INSERT INTO inbox_entries(owner,id,body,created_at) VALUES(?,?,?,?)').run(owner,id,'Synthetic source input',created);return id}
function storedTask(owner,t,deleted=0){sqlite.prepare('INSERT INTO tasks(owner,id,data,revision,deleted) VALUES(?,?,?,?,?)').run(owner,t.id,JSON.stringify(t),t.revision,deleted)}
function edit(owner,t){sqlite.prepare('UPDATE tasks SET data=?,revision=? WHERE owner=? AND id=?').run(JSON.stringify(t),t.revision,owner,t.id)}
function change(t,kind='update',automatic=true){return {id:crypto.randomUUID(),kind,task:t,reason:'Synthetic user input explicitly requests this change',automatic}}
function plan(entryId,changes){return {action:'plan',entryId,summary:'Synthetic first frozen plan',changes}}
async function authorized(owner='alice'){
 await api.ensureProfile(owner);const accountKey=await api.accountKey(owner);await api.updateGrant(owner,accountKey,true);
 const {job}=await api.claimJob({accountKey,requestId:crypto.randomUUID()},'a'.repeat(64));
 const auth={jobId:job.id,generation:job.generation,leaseToken:job.leaseToken};const {lease}=await api.resolveLease(auth);return {accountKey,job,auth,lease};
}
function proposal(id){const row=raw('SELECT * FROM task_changes WHERE owner=? AND id=?','alice',id);return {...row,before:row.before_data?JSON.parse(row.before_data):null,after:JSON.parse(row.after_data)}}
const conflict=e=>e.code==='CONFLICT';

test('stale update freezes once for manual review, preserves the current task, and allows safe creates and later input',async()=>{
 const {lease,auth}=await authorized(),original=task();storedTask('alice',original);
 const first=entry(),second=entry('alice','2026-09-02T00:00:00.000Z');
 // This is the real failure trigger: an edit after remote context but before plan.
 const context=await api.agentAction({action:'context',...auth},'a'.repeat(64));assert.equal(context.tasks[0].revision,0);
 const current={...original,note:'User changed this note while planning',revision:1};edit('alice',current);
 const requested={...original,note:'Initial note\nRemote append'},stale=change(requested),newTask=task({title:'Independent safe new task'}),create=change(newTask,'create');
 const frozen=await api.savePlan('alice',plan(first,[stale,create]),lease),review=proposal(stale.id);
 assert.equal(raw('SELECT state FROM inbox_entries WHERE id=?',first).state,'processed');assert.equal(frozen.alreadyProcessed,false);
 assert.equal(review.state,'pending');assert.equal(review.automatic,0);assert.deepEqual(review.before,current);assert.deepEqual(review.after,{...requested,revision:1});assert.match(review.reason,/修改|变化|版本/);
 assert.deepEqual(JSON.parse(raw('SELECT data FROM tasks WHERE id=?',original.id).data),current);
 assert.equal(proposal(create.id).state,'applied');assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',newTask.id).deleted,0);
 const replay=await api.savePlan('alice',plan(first,[change(task({title:'A replacement must not win'}),'create')]),lease);assert.equal(replay.alreadyProcessed,true);assert.deepEqual(replay.receipt,frozen.receipt);assert.equal(raw('SELECT COUNT(*) AS n FROM task_changes').n,2);
 await api.savePlan('alice',plan(second,[change(task({title:'Next source is not blocked'}),'create')]),lease);assert.equal(raw('SELECT state FROM inbox_entries WHERE id=?',second).state,'processed');
 assert.deepEqual(await api.resumeAutomatic('alice',lease),{ok:true,errors:[]});assert.equal(proposal(stale.id).state,'pending');
 await api.applyChange('alice',stale.id,false);assert.equal(proposal(stale.id).state,'applied');assert.deepEqual(JSON.parse(raw('SELECT data FROM tasks WHERE id=?',original.id).data),{...requested,revision:2});
});

test('manual adoption of a demoted proposal still rejects a subsequent task edit',async()=>{
 const {lease}=await authorized(),original=task();storedTask('alice',original);const first=entry();
 const current={...original,title:'User renamed the task',revision:2};edit('alice',current);const c=change({...original,note:'Initial note\nAppend'});
 await api.savePlan('alice',plan(first,[c]),lease);assert.equal(proposal(c.id).after.revision,2);
 const latest={...current,note:'Another user edit after freeze',revision:3};edit('alice',latest);
 await assert.rejects(api.applyChange('alice',c.id,false),conflict);assert.equal(proposal(c.id).state,'pending');assert.equal(proposal(c.id).automatic,0);
 assert.deepEqual(JSON.parse(raw('SELECT data FROM tasks WHERE id=?',original.id).data),latest);
});

test('stale delete becomes an explicit user decision and never executes automatically',async()=>{
 const {lease}=await authorized(),original=task();storedTask('alice',original);const first=entry(),current={...original,title:'Current user title',revision:2};edit('alice',current);
 const c=change(original,'delete');await api.savePlan('alice',plan(first,[c]),lease);const review=proposal(c.id);
 assert.equal(review.state,'pending');assert.equal(review.automatic,0);assert.deepEqual(review.before,current);assert.equal(review.after.revision,2);assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',original.id).deleted,0);
 await assert.rejects(api.applyChange('alice',c.id,true,lease),conflict);await api.applyChange('alice',c.id,false);
 assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',original.id).deleted,1);assert.equal(raw('SELECT revision FROM tasks WHERE id=?',original.id).revision,3);
});

test('deleted and missing targets become superseded receipts, never revive, and do not block independent work',async()=>{
 const {lease}=await authorized(),removed=task({title:'Removed synthetic task',revision:1}),missing=task({title:'Missing synthetic task'});storedTask('alice',removed,1);
 const first=entry(),second=entry('alice','2026-09-02T00:00:00.000Z'),removedChange=change({...removed,revision:0,note:'Stale update'}),missingChange=change(missing),newTask=task({title:'Safe independent addition'}),create=change(newTask,'create');
 const frozen=await api.savePlan('alice',plan(first,[removedChange,missingChange,create]),lease);
 assert.equal(raw('SELECT state FROM inbox_entries WHERE id=?',first).state,'processed');assert.equal(frozen.receipt.changeIds.length,3);
 for(const id of [removedChange.id,missingChange.id]){const c=proposal(id);assert.equal(c.state,'superseded');assert.equal(c.automatic,0);assert.match(c.reason,/删除|不存在|失效|移除/);await assert.rejects(api.applyChange('alice',id,false),conflict)}
 assert.deepEqual(proposal(removedChange.id).before,removed);assert.equal(proposal(missingChange.id).before,null);
 assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',removed.id).deleted,1);assert.equal(raw('SELECT revision FROM tasks WHERE id=?',removed.id).revision,1);assert.equal(raw('SELECT id FROM tasks WHERE id=?',missing.id),undefined);assert.equal(proposal(create.id).state,'applied');
 assert.deepEqual(await api.resumeAutomatic('alice',lease),{ok:true,errors:[]});await api.savePlan('alice',plan(second,[change(task({title:'Later source progresses'}),'create')]),lease);
 const snapshot=await api.createSnapshot('alice',lease);assert.equal(snapshot.tables.task_changes.filter(c=>c.state==='superseded').length,2);assert.equal(snapshot.tables.tasks.find(t=>t.id===removed.id).deleted,1);
});

test('an edit inside the freeze transaction fences automatic apply and leaves a reviewable frozen receipt',async()=>{
 const {lease}=await authorized(),original=task();storedTask('alice',original);const first=entry(),c=change({...original,note:'Initial note\nSafe append'});
 const current={...original,note:'Concurrent user edit at commit',revision:1};preBatch=()=>edit('alice',current);
 await api.savePlan('alice',plan(first,[c]),lease);assert.equal(raw('SELECT state FROM inbox_entries WHERE id=?',first).state,'processed');assert.equal(proposal(c.id).state,'pending');assert.equal(proposal(c.id).automatic,0);
 assert.deepEqual(JSON.parse(raw('SELECT data FROM tasks WHERE id=?',original.id).data),current);await assert.rejects(api.applyChange('alice',c.id,false),conflict);
});

test('stale-plan demotion does not weaken final-transaction grant and lease checks',async()=>{
 const {lease}=await authorized(),original=task();storedTask('alice',original);edit('alice',{...original,revision:1});const first=entry(),c=change({...original,note:'A stale append'});
 preBatch=()=>sqlite.exec("UPDATE organizer_grants SET enabled=0,generation=generation+1 WHERE owner='alice'");
 await assert.rejects(api.savePlan('alice',plan(first,[c]),lease),e=>e.code==='LEASE_LOST');assert.equal(raw('SELECT state FROM inbox_entries WHERE id=?',first).state,'pending');assert.equal(raw('SELECT COUNT(*) AS n FROM task_changes').n,0);assert.equal(raw('SELECT revision FROM tasks WHERE id=?',original.id).revision,1);
});

test('bounded history retains latest entry/change associations and prioritizes pending work; full snapshot remains complete',async()=>{
 await api.ensureProfile('alice');const associations=new Map(),base=Date.parse('2026-09-01T00:00:00Z');
 for(let i=0;i<500;i++){
  const created=new Date(base+i*60000).toISOString(),entryId=entry('alice',created),t=task({title:`Synthetic history ${i}`}),changeId=crypto.randomUUID();
  sqlite.prepare("UPDATE inbox_entries SET state='processed',summary=?,processed_at=?,plan_token=? WHERE owner=? AND id=?").run(`Synthetic history ${i}`,created,crypto.randomUUID(),'alice',entryId);
  sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,state,created_at,decided_at) VALUES(?,?,?,'create',?,'Synthetic history',0,'applied',?,?)").run('alice',changeId,entryId,JSON.stringify(t),created,created);associations.set(entryId,changeId);
 }
 const pending=entry('alice','2025-01-01T00:00:00.000Z'),pendingChange=crypto.randomUUID();sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,created_at) VALUES(?,?,?,'create',?,'Synthetic pending',0,?)").run('alice',pendingChange,pending,JSON.stringify(task({title:'Pending user choice'})),'2025-01-01T00:00:00.000Z');entry('bob');
 const state=await api.organizerState('alice',false);assert.equal(state.entries.length,150);assert.equal(state.entries[0].id,pending);assert.equal(state.changes[0].id,pendingChange);
 const returned=new Set(state.changes.map(c=>c.id));for(const e of state.entries.filter(e=>e.state==='processed'))assert.equal(returned.has(associations.get(e.id)),true,`Displayed processed entry ${e.id} has no associated result`);
 assert.match(state.entries[1].summary,/499$/);assert.equal(state.changes.every(c=>c.entry_id!==raw('SELECT id FROM inbox_entries WHERE owner=?','bob').id),true);
 const snapshot=await api.createSnapshot('alice');assert.equal(snapshot.counts.inbox_entries,501);assert.equal(snapshot.counts.task_changes,501);assert.equal(snapshot.tables.task_changes.every(c=>c.owner==='alice'),true);
});

test('every displayed result is complete above 400 changes, and pending decisions survive outside the 150 displayed inputs',async()=>{
 await api.ensureProfile('alice');const associations=new Map(),base=Date.parse('2026-09-01T00:00:00Z');let oldest;
 for(let i=0;i<175;i++){
  const created=new Date(base+i*60000).toISOString(),entryId=entry('alice',created);oldest??=entryId;
  sqlite.prepare("UPDATE inbox_entries SET state='processed',summary=?,processed_at=? WHERE id=? AND owner=?").run(`Synthetic multi-change history ${i}`,created,entryId,'alice');
  const ids=[];for(let j=0;j<3;j++){
   const id=crypto.randomUUID();sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,state,created_at,decided_at) VALUES(?,?,?,'create',?,'Synthetic completed result',0,'applied',?,?)").run('alice',id,entryId,JSON.stringify(task({title:`Synthetic ${i}/${j}`})),created,created);ids.push(id);
  }associations.set(entryId,ids);
 }
 for(let i=0;i<401;i++)sqlite.prepare("INSERT INTO task_changes(owner,id,entry_id,kind,after_data,reason,automatic,created_at) VALUES(?,?,?,'create',?,'Synthetic pending old input',0,?)").run('alice',crypto.randomUUID(),oldest,JSON.stringify(task({title:`Synthetic pending ${i}`})),'2025-01-01T00:00:00.000Z');
 const state=await api.organizerState('alice',false),returned=new Set(state.changes.map(c=>c.id));assert.equal(state.entries.length,150);assert.equal(state.entries.some(e=>e.id===oldest),false);assert.equal(state.changes.filter(c=>c.state==='pending').length,401);
 for(const e of state.entries)for(const id of associations.get(e.id))assert.equal(returned.has(id),true,'A visible source must return all its changes');
 for(const id of associations.get(oldest))assert.equal(returned.has(id),false,'Old completed results need not crowd the current view');
 assert.equal(state.changes.length,851);const snapshot=await api.createSnapshot('alice');assert.equal(snapshot.counts.inbox_entries,175);assert.equal(snapshot.counts.task_changes,926);
});
