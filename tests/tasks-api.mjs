// real isolated SQLite. No real user, network, .wrangler or .liubai is accessed.
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
const temporary=await mkdtemp(join(tmpdir(),'liubai-task-api-proposal-'));
const bundle=await build({stdin:{contents:"export * as tasks from './app/api/tasks/route'; export * from './lib/account'; export * from './lib/organizer';",resolveDir:ROOT,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node22',write:false,plugins:[{name:'synthetic-auth-and-d1',setup(b){
 b.onLoad({filter:/\/lib\/database\.ts$/},()=>({contents:'export function database(){return globalThis.__liubaiRouteTestDB}',loader:'js'}));
 b.onLoad({filter:/\/app\/chatgpt-auth\.ts$/},()=>({contents:'export async function getChatGPTUser(){return globalThis.__liubaiRouteTestUser}',loader:'js'}));
}}]});
await writeFile(join(temporary,'route.mjs'),bundle.outputFiles[0].contents);
const api=await import(pathToFileURL(join(temporary,'route.mjs')).href);
const migrationSQL=await Promise.all((await readdir(join(ROOT,'drizzle'))).filter(n=>n.endsWith('.sql')).sort().map(n=>readFile(join(ROOT,'drizzle',n),'utf8')));
let sqlite,preRun;
class Statement {
 constructor(sql,values=[]){this.sql=sql;this.values=values}
 bind(...values){return new Statement(this.sql,values)}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.values),meta:{changes:0}}}
 async first(){return sqlite.prepare(this.sql).get(...this.values)??null}
 async run(){const hook=preRun;preRun=null;if(hook)hook();return this.execute()}
 execute(){const s=sqlite.prepare(this.sql);if(s.columns().length)return {results:s.all(...this.values),meta:{changes:0}};return {results:[],meta:{changes:Number(s.run(...this.values).changes)}}}
}
function openDatabase(file=':memory:'){sqlite?.close();sqlite=new DatabaseSync(file)}
function initializeDatabase(){for(const sql of migrationSQL)sqlite.exec(sql)}
beforeEach(()=>{
 openDatabase();initializeDatabase();preRun=null;
 globalThis.__liubaiRouteTestUser={userId:'synthetic-alice',local:false,displayName:'Synthetic Alice',email:'alice@example.invalid',fullName:null};
 globalThis.__liubaiRouteTestDB={prepare:sql=>new Statement(sql),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.execute());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
});
after(async()=>{sqlite?.close();delete globalThis.__liubaiRouteTestDB;delete globalThis.__liubaiRouteTestUser;await rm(temporary,{recursive:true,force:true})});
const task=(overrides={})=>({id:crypto.randomUUID(),title:'Synthetic task',note:'Synthetic note',quadrant:1,category:'工作',due:'',deadline:'',urgencyMode:'manualNormal',done:false,subtasks:[],revision:0,...overrides});
const raw=(sql,...values)=>sqlite.prepare(sql).get(...values);
async function post(body,{accountKey,origin='https://liubai.example'}={}){
 const key=accountKey??(globalThis.__liubaiRouteTestUser?await api.accountKey(globalThis.__liubaiRouteTestUser.userId):'');
 const headers={'Content-Type':'application/json',Origin:origin};if(key)headers['X-Liubai-Account']=key;
 const response=await api.tasks.POST(new Request('https://liubai.example/api/tasks',{method:'POST',headers,body:JSON.stringify(body)}));
 return {status:response.status,body:await response.json()};
}
async function get(){const response=await api.tasks.GET();return {status:response.status,body:await response.json()}}
async function create(t){const response=await post({action:'create',task:t});assert.equal(response.status,200);return response.body.task}

test('GET reports identity and default validated urgency preferences, then initialization retries safely',async()=>{
 const first=await get();assert.equal(first.status,200);assert.equal(first.body.initialized,false);assert.deepEqual(first.body.tasks,[]);
 assert.equal(first.body.account.key,await api.accountKey('synthetic-alice'));assert.equal(first.body.account.mode,'cloud');
 assert.deepEqual(first.body.urgencyPreferences,{urgentDays:3,timezone:'Asia/Shanghai'});
 assert.equal((await post({action:'initialize',today:'2026-10-08',samples:false})).status,200);
 assert.equal((await post({action:'initialize',today:'2026-10-09',samples:true})).status,200);
 assert.equal((await get()).body.initialized,true);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,0);
});

test('production route creates, reads, updates, rejects stale edits, and acknowledges exact retries',async()=>{
 const original=task(),saved=await create(original);assert.equal(saved.revision,0);
 assert.equal((await post({action:'create',task:original})).status,200);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);
 assert.equal((await post({action:'create',task:{...original,note:'different retry'}})).status,409);
 const update={...saved,note:'Updated synthetic note'},first=await post({action:'update',task:update});assert.equal(first.status,200);assert.equal(first.body.task.revision,1);
 const again=await post({action:'update',task:update});assert.equal(again.status,200);assert.deepEqual(again.body.task,first.body.task);
 assert.equal((await post({action:'update',task:{...update,note:'Stale overwrite'}})).status,409);
 const read=await get();assert.equal(read.body.tasks.length,1);assert.equal(read.body.tasks[0].note,update.note);assert.equal(read.body.tasks[0].revision,1);
});

test('completion normalizes subtasks; an incomplete task retains its completed steps',async()=>{
 const original=task({subtasks:[{id:'synthetic-step',title:'Synthetic step',done:false}]});await create(original);
 const completed=await post({action:'update',task:{...original,done:true}});assert.equal(completed.status,200);assert.equal(completed.body.task.subtasks[0].done,true);
 const reopened=await post({action:'update',task:{...completed.body.task,done:false}});assert.equal(reopened.status,200);assert.equal(reopened.body.task.subtasks[0].done,true);
});

test('deletion remains a tombstone; ordinary updates/create cannot revive it, explicit restore retries safely',async()=>{
 const original=task();await create(original);const deleted=await post({action:'delete',id:original.id,revision:0});assert.equal(deleted.status,200);assert.equal(deleted.body.revision,1);
 assert.equal((await post({action:'delete',id:original.id,revision:0})).status,200);assert.deepEqual((await get()).body.tasks,[]);
 assert.equal(raw('SELECT deleted FROM tasks WHERE owner=? AND id=?','synthetic-alice',original.id).deleted,1);
 assert.equal((await post({action:'update',task:{...original,revision:1}})).status,409);
 assert.equal((await post({action:'create',task:original})).status,409);
 assert.equal((await post({action:'restore',id:original.id,revision:0})).status,409);
 const restored=await post({action:'restore',id:original.id,revision:deleted.body.revision});assert.equal(restored.status,200);assert.equal(restored.body.task.revision,2);assert.equal(restored.body.task.note,original.note);
 assert.deepEqual((await post({action:'restore',id:original.id,revision:1})).body.task,restored.body.task);
 assert.equal((await get()).body.tasks[0].revision,2);assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',original.id).deleted,0);
 const edited=await post({action:'update',task:{...restored.body.task,note:'Manual edit after restore'}});assert.equal(edited.status,200);
 assert.equal((await post({action:'restore',id:original.id,revision:1})).status,409);
 assert.equal((await get()).body.tasks[0].note,'Manual edit after restore');
});

test('restoration requires deletion and cannot revive a newer deletion with an old receipt',async()=>{
 const original=task();await create(original);assert.equal((await post({action:'restore',id:original.id,revision:0})).status,409);
 await post({action:'delete',id:original.id,revision:0});const restored=await post({action:'restore',id:original.id,revision:1});assert.equal(restored.status,200);
 await post({action:'delete',id:original.id,revision:2});assert.equal((await post({action:'restore',id:original.id,revision:1})).status,409);
 assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',original.id).deleted,1);assert.equal(raw('SELECT revision FROM tasks WHERE id=?',original.id).revision,3);
});

test('trusted owner scopes reads and writes; mismatched account handshakes and origins fail before mutation',async()=>{
 const original=task();await create(original);await post({action:'delete',id:original.id,revision:0});const aliceKey=await api.accountKey('synthetic-alice');
 globalThis.__liubaiRouteTestUser={...globalThis.__liubaiRouteTestUser,userId:'synthetic-bob',displayName:'Synthetic Bob'};
 assert.deepEqual((await get()).body.tasks,[]);
 assert.equal((await post({action:'restore',id:original.id,revision:1})).status,409);
 assert.equal((await post({action:'update',task:original})).status,409);
 assert.equal((await post({action:'delete',id:original.id,revision:0})).status,409);
 const mismatched=await post({action:'create',task:task()},{accountKey:aliceKey});assert.equal(mismatched.status,409);assert.equal(mismatched.body.code,'ACCOUNT_CHANGED');
 assert.equal((await post({action:'create',task:task()},{accountKey:''})).status,409);
 assert.equal((await post({action:'create',task:task()},{origin:'https://other.example'})).status,403);
 assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);assert.equal(raw('SELECT deleted FROM tasks WHERE owner=? AND id=?','synthetic-alice',original.id).deleted,1);
});

test('signed-out requests fail without exposing account tasks or writing new data',async()=>{
 await create(task());globalThis.__liubaiRouteTestUser=null;const read=await get();assert.equal(read.status,401);assert.equal(read.body.tasks,undefined);
 assert.equal((await post({action:'create',task:task()})).status,401);assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,1);
});

test('GET uses persisted valid urgency preferences and fails closed on invalid stored profiles',async()=>{
 await create(task());const profile={...api.defaultProfile,urgentDays:7,timezone:'UTC'};
 sqlite.prepare('INSERT INTO organizer_profiles(owner,data) VALUES(?,?)').run('synthetic-alice',JSON.stringify(profile));
 assert.deepEqual((await get()).body.urgencyPreferences,{urgentDays:7,timezone:'UTC'});
 for(const invalid of [{...profile,urgentDays:31},{...profile,timezone:'Not/AZone'},'malformed']){
  sqlite.prepare('UPDATE organizer_profiles SET data=? WHERE owner=?').run(invalid==='malformed'?'{':JSON.stringify(invalid),'synthetic-alice');
  const response=await get();assert.equal(response.status,503);assert.equal(response.body.tasks,undefined);assert.equal(response.body.urgencyPreferences,undefined);
 }
});

test('task content, deletion and profile persist across an isolated file-SQLite restart',async()=>{
 const file=join(temporary,'restart.sqlite');openDatabase(file);initializeDatabase();
 const active=task(),deleted=task({title:'Synthetic removed'});await create(active);await create(deleted);await post({action:'delete',id:deleted.id,revision:0});
 sqlite.prepare('INSERT INTO organizer_profiles(owner,data) VALUES(?,?)').run('synthetic-alice',JSON.stringify({...api.defaultProfile,urgentDays:9,timezone:'UTC'}));
 openDatabase(file);const read=await get();assert.equal(read.status,200);assert.equal(read.body.tasks.length,1);assert.equal(read.body.tasks[0].id,active.id);
 assert.deepEqual(read.body.urgencyPreferences,{urgentDays:9,timezone:'UTC'});assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',deleted.id).deleted,1);
 const restored=await post({action:'restore',id:deleted.id,revision:1});assert.equal(restored.status,200);assert.equal(restored.body.task.revision,2);
});

// Another request restores the same tombstone between this request's read/CAS.
test('duplicate restore racing after the tombstone read returns the same successful receipt',async()=>{
 const original=task();await create(original);await post({action:'delete',id:original.id,revision:0});
 preRun=()=>{
  const stored=raw('SELECT data FROM tasks WHERE owner=? AND id=?','synthetic-alice',original.id);
  const restored={...JSON.parse(stored.data),revision:2};
  sqlite.prepare('UPDATE tasks SET deleted=0,data=?,revision=2 WHERE owner=? AND id=? AND revision=1 AND deleted=1').run(JSON.stringify(restored),'synthetic-alice',original.id);
 };
 const response=await post({action:'restore',id:original.id,revision:1});
 assert.equal(raw('SELECT deleted FROM tasks WHERE id=?',original.id).deleted,0);
 assert.equal(raw('SELECT revision FROM tasks WHERE id=?',original.id).revision,2);
 assert.equal(response.status,200,'The identical concurrent restore committed successfully, so its receipt should be acknowledged');
 assert.equal(response.body.task.revision,2);
});

test('invalid dates, duplicated substeps and unsupported categories never write a task',async()=>{
 for(const fields of [{due:'2026-02-30'},{deadline:'2026-13-01'},{quadrant:4},{category:'unsupported'},{subtasks:[{id:'same',title:'First',done:false},{id:'same',title:'Second',done:false}]}]){
  assert.equal((await post({action:'create',task:task(fields)})).status,400);
 }
 assert.equal(raw('SELECT COUNT(*) AS n FROM tasks').n,0);
});
