import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,chmod,lstat,mkdir,writeFile,utimes,symlink} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {validateConfig,createRemoteClient,remoteMain,readJSONInput} from '../scripts/remote-organizer.mjs';
import {encryptSnapshot,decryptSnapshot,rehearseRestore,saveSnapshot,writePrivateJSON,readPrivateJSON,digest,pruneBackups} from '../scripts/backups.mjs';
import {buildImportRequest} from '../scripts/import-tasks.mjs';

const config=()=>({url:'https://liubai.example',sitesToken:'s'.repeat(32),agentToken:'a'.repeat(32),backupKey:randomBytes(32).toString('base64')});
const stream=value=>Readable.from([JSON.stringify(value)]);
const snapshot=()=>({format:'liubai-snapshot',version:1,accountKey:digest('liubai-account-v1:owner-a'),businessHash:'business-1',tables:{tasks:[{owner:'owner-a',id:'task-a',data:'{"title":"测试"}',revision:0,deleted:0}],spaces:[{owner:'owner-a',initialized:1}],inbox_entries:[],task_changes:[],organizer_profiles:[],task_imports:[]},counts:{tasks:1,spaces:1,inbox_entries:0,task_changes:0,organizer_profiles:0,task_imports:0}});
test('remote URL and request transport never follow another origin',async()=>{for(const url of ['http://liubai.example','https://user:secret@liubai.example','https://liubai.example/other','https://liubai.example?token=x','https://localhost'])assert.throws(()=>validateConfig({...config(),url}));let options;const cfg=config(),client=createRemoteClient(cfg,async(url,opts)=>{assert.equal(url,'https://liubai.example/api/agent/jobs');options=opts;return Response.json({accounts:[]});});await client('queue');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,`Bearer ${cfg.agentToken}`);assert.equal(options.headers['OAI-Sites-Authorization'],`Bearer ${cfg.sitesToken}`);const failure=createRemoteClient(cfg,async()=>Response.json({error:'private input should never be printed'},{status:409}));await assert.rejects(()=>failure('plan'),error=>!error.message.includes('private input')&&error.message.includes('409'));});
test('non-JSON responses report only HTTP status and validated Cloudflare diagnostics',async()=>{
 const cfg=config(),body=`<html>private raw input ${cfg.sitesToken} ${cfg.agentToken}</html>`,response=new Response(body,{status:403,headers:{'content-type':'text/html','cf-ray':'9cba123456789abc-SJC','cf-mitigated':'challenge',location:'https://private.example/secret','set-cookie':'private-cookie=value',server:'private-server'}});
 const client=createRemoteClient(cfg,async()=>response);
 await assert.rejects(()=>client('queue'),error=>{assert.equal(error.message,'云端连接未确认（HTTP 403；cf-ray=9cba123456789abc-SJC；cf-mitigated=challenge）；站点未返回 API 响应，请保留已有 job 与计划后重试');return true;});
 assert.equal(response.bodyUsed,false);
});
test('invalid or missing edge identifiers never enter a non-JSON error',async()=>{
 const cases=[{}, {'cf-ray':'9cba123456789abc-SJC extra-secret','cf-mitigated':'challenge extra-secret'}, {'cf-ray':'9cba123456789abc-SJC\nsecret','cf-mitigated':'challenge\nsecret'}, {'cf-ray':'9cba123456789abc\n','cf-mitigated':'challenge\n'}, {'cf-ray':'a'.repeat(500),'cf-mitigated':'unknown'}, {'cf-ray':'9cba123456789abc-SJCTOOLONG','cf-mitigated':'CHALLENGE'}];
 for(const headers of cases){const client=createRemoteClient(config(),async()=>({status:503,headers:{get:key=>headers[key]??null},json:()=>assert.fail('must not consume non-JSON response')}));await assert.rejects(()=>client('queue'),error=>{assert.equal(error.message,'云端连接未确认（HTTP 503）；站点未返回 API 响应，请保留已有 job 与计划后重试');return true;});}
});
test('configuration file requires private permissions',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'liubai-cli-test-'));const file=path.join(root,'remote.json');await writePrivateJSON(file,config());assert.equal((await lstat(file)).mode&0o777,0o600);await chmod(file,0o644);await assert.rejects(()=>readPrivateJSON(file),/600/);});
test('stdin is exactly one JSON object',async()=>{await assert.rejects(()=>readJSONInput(Readable.from(['{}{}'])),/单个JSON/);await assert.rejects(()=>readJSONInput(Readable.from(['[]'])),/单个JSON/);assert.deepEqual(await readJSONInput(stream({ok:true})),{ok:true});});
test('claim retry identity, private context, frozen plan and account boundary',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'liubai-cli-test-'));const cfg=config();await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);const output=[],requests=[];let contextAccount='account-a';const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body||'{}');requests.push(body);const job={id:'job-a',accountKey:'account-a',generation:1,leaseToken:'lease-private-token',leaseUntil:'2030-01-01T00:00:00.000Z',state:'leased'};if(body.action==='claim')return Response.json({job});if(body.action==='context')return Response.json({jobId:'job-a',accountKey:contextAccount,entries:[{id:'10000000-0000-4000-8000-000000000001',body:'private raw input'}],tasks:[],pendingChanges:[]});return Response.json({ok:true});};const run=(args,value)=>remoteMain(args,{root,fetchImpl,input:stream(value||{}),print:value=>output.push(value)});await run(['claim','account-a']);await run(['claim','account-a']);assert.equal(requests[0].requestId,requests[1].requestId);await run(['context','job-a']);assert(!JSON.stringify(output).includes('private raw input'));assert(!JSON.stringify(output).includes('lease-private-token'));const plan={entryId:'10000000-0000-4000-8000-000000000001',summary:'summary',changes:[]};await run(['plan','job-a'],plan);await run(['plan','job-a'],plan);await assert.rejects(()=>run(['plan','job-a'],{...plan,summary:'different'}),/冻结/);await assert.rejects(()=>run(['plan','job-a'],{...plan,entryId:'10000000-0000-4000-8000-000000000002'}),/不属于/);contextAccount='account-b';await assert.rejects(()=>run(['context','job-a']),/账号不匹配/);assert.equal((await readPrivateJSON(path.join(root,'.liubai/jobs/job-a/context.json'))).accountKey,'account-a');});
test('encrypted backup catches tampering, preserves counts, never restores authorization',async()=>{const cfg=config(),plain=snapshot();plain.tables.organizer_grants=[{owner:'owner-a',enabled:1}];plain.counts.organizer_grants=1;const encrypted=encryptSnapshot(plain,cfg.backupKey);assert(!JSON.stringify(encrypted).includes('测试'));assert.deepEqual(decryptSnapshot(encrypted,cfg.backupKey),plain);assert.throws(()=>decryptSnapshot({...encrypted,accountKey:'other'},cfg.backupKey),/完整性/);assert.throws(()=>decryptSnapshot(encrypted,config().backupKey),/完整性/);const result=await rehearseRestore(decryptSnapshot(encrypted,cfg.backupKey));assert.equal(result.counts.tasks,1);assert.deepEqual(result.excludedTables,['organizer_grants']);assert.equal(result.leasesRestored,false);assert.equal(result.runtimeAuthorizationRestored,false);});
test('snapshot watermark updates only after verified disk write; unchanged content skips',async()=>{const directory=await mkdtemp(path.join(os.tmpdir(),'liubai-backup-test-')),cfg=config(),options={directory,key:cfg.backupKey,source:cfg.url};const first=await saveSnapshot(snapshot(),options);assert.equal(first.changed,true);assert.equal((await lstat(first.file)).mode&0o777,0o600);assert.equal((await saveSnapshot(snapshot(),options)).changed,false);assert.equal(decryptSnapshot(JSON.parse(await readFile(first.file,'utf8')),cfg.backupKey).tables.tasks.length,1);await assert.rejects(()=>saveSnapshot({...snapshot(),counts:{tasks:2}},options),/行数/);});
test('restore rejects snapshot-provided columns instead of executing them',async()=>{const plain=snapshot();plain.tables.tasks[0]['x); DROP TABLE tasks; --']='bad';await assert.rejects(()=>rehearseRestore(plain),/未知业务列/);});
test('import is account-bound, source-stable and task-only with completed rows',()=>{const local=snapshot(),cloud=snapshot();local.tables.tasks.push({owner:'owner-a',id:'done-task',data:'{"title":"done","done":true}',revision:3,deleted:0},{owner:'owner-a',id:'deleted-task',data:'{"title":"deleted"}',revision:2,deleted:1});local.counts.tasks=3;local.tables.inbox_entries.push({owner:'owner-a',body:'must not upload this raw inbox'});local.counts.inbox_entries=1;const first=buildImportRequest(local,cloud,cloud.accountKey),second=buildImportRequest(local,cloud,cloud.accountKey);assert.equal(first.sourceId,second.sourceId);assert.equal(first.tasks.length,2);assert(first.tasks.some(task=>task.done));assert(!JSON.stringify(first).includes('must not upload'));assert(!first.tasks.some(task=>task.id==='deleted-task'));assert.notEqual(first.batchId,second.batchId);assert.throws(()=>buildImportRequest(local,cloud,'wrong-account'),/不匹配/);});
test('a full snapshot rejects foreign-account rows',()=>{const plain=snapshot();plain.tables.tasks[0].owner='owner-b';assert.throws(()=>encryptSnapshot(plain,config().backupKey),/不属于/);});
test('expired claim can recover while renewal keeps the private lease token',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'liubai-cli-test-'));await writePrivateJSON(path.join(root,'.liubai/remote.json'),config());const requests=[],job={id:'job-recovery',accountKey:'account-a',generation:1,leaseToken:'private-lease-value',leaseUntil:'2030-01-01T00:00:00Z',state:'leased'};let claims=0;const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);if(body.action==='claim'){claims++;if(claims===1)return Response.json({code:'LEASE_LOST'},{status:409});return Response.json({job});}const {leaseToken,...publicJob}=job;return Response.json({job:{...publicJob,leaseUntil:'2030-01-01T00:20:00Z'}});};const run=args=>remoteMain(args,{root,fetchImpl,print:()=>{}});await run(['claim','account-a']);assert.notEqual(requests[0].requestId,requests[1].requestId);await run(['renew','job-recovery']);const saved=await readPrivateJSON(path.join(root,'.liubai/jobs/job-recovery/lease.json'));assert.equal(saved.leaseToken,job.leaseToken);assert.equal(saved.leaseUntil,'2030-01-01T00:20:00Z');});
test('server snapshot manifest hash is verified independently',()=>{const plain=snapshot();plain.hashAlgorithm='sha256-canonical-json-v1';plain.snapshotHash=digest(plain.tables);plain.businessHash=digest(plain.tables);const encrypted=encryptSnapshot(plain,config().backupKey);assert(encrypted.ciphertext);plain.tables.tasks[0].data='changed';assert.throws(()=>encryptSnapshot(plain,config().backupKey),/校验和/);});
test('restore rehearsal enforces original composite primary keys',async()=>{const plain=snapshot();plain.tables.tasks.push({...plain.tables.tasks[0]});plain.counts.tasks=2;await assert.rejects(()=>rehearseRestore(plain),/UNIQUE/);});
test('global prune expires revoked-account backups without reading data or following symlinks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-prune-test-')),directory=path.join(root,'backups'),account=path.join(directory,'a'.repeat(64)),prior=path.join(directory,'before-upgrade-original'),outside=path.join(root,'outside');
 await Promise.all([mkdir(account,{recursive:true}),mkdir(prior,{recursive:true}),mkdir(outside,{recursive:true})]);
 const now=new Date(),old=new Date(now.getTime()-31*86400000),recent=new Date(now.getTime()-29*86400000);
 async function file(name,time){await writeFile(name,'deliberately not JSON',{mode:0o600});await utimes(name,time,time);}
 const expired=path.join(account,'old.json.enc'),fresh=path.join(account,'fresh.json.enc'),watermark=path.join(account,'watermark.json'),original=path.join(prior,'original.json.enc'),external=path.join(outside,'outside.json.enc');
 await Promise.all([file(expired,old),file(fresh,recent),file(watermark,old),file(original,old),file(external,old)]);
 await symlink(external,path.join(account,'link.json.enc'));await symlink(outside,path.join(directory,'b'.repeat(64)));
 const result=await pruneBackups(directory,{now});assert.equal(result.removedFiles,1);assert.equal(result.removedWatermarks,1);assert.equal(result.checkedDirectories,1);
 await assert.rejects(()=>lstat(expired),{code:'ENOENT'});await assert.rejects(()=>lstat(watermark),{code:'ENOENT'});
 for(const retained of [fresh,original,external])assert((await lstat(retained)).isFile());assert((await lstat(path.join(account,'link.json.enc'))).isSymbolicLink());
 const rootLink=path.join(root,'linked-backups');await symlink(directory,rootLink);await assert.rejects(()=>pruneBackups(rootLink),/不安全/);
});
test('expired last snapshot is removed and the next authorized snapshot resets its watermark',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'liubai-prune-last-')),cfg=config(),options={directory,key:cfg.backupKey,source:cfg.url},first=await saveSnapshot(snapshot(),options),old=new Date(Date.now()-31*86400000);
 await utimes(first.file,old,old);await utimes(path.join(path.dirname(first.file),'watermark.json'),old,old);
 const removed=await pruneBackups(directory);assert.equal(removed.removedFiles,1);assert.equal(removed.removedWatermarks,1);
 const renewed=await saveSnapshot(snapshot(),options);assert.equal(renewed.changed,true);assert.notEqual(renewed.file,first.file);
});
test('frozen plans survive an expired job and a fresh account context cannot replace them',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-frozen-test-')),cfg=config(),accountKey='account-a',plan={entryId:'10000000-0000-4000-8000-000000000003',summary:'first plan',changes:[]};
 await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);let failFirst=true;const submissions=[];
 const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);if(body.action==='context')return Response.json({jobId:body.jobId,accountKey,entries:[{id:plan.entryId,body:'private'}],tasks:[],pendingChanges:[]});if(body.action==='plan'){submissions.push(body);if(failFirst){failFirst=false;throw Error('response lost before confirmation');}}return Response.json({ok:true});};
 async function lease(id,generation){await writePrivateJSON(path.join(root,'.liubai/jobs',id,'lease.json'),{id,accountKey,generation,leaseToken:'private-lease',leaseUntil:'2030-01-01T00:00:00Z',state:'leased',source:cfg.url});}
 const run=(args,value={})=>remoteMain(args,{root,fetchImpl,input:stream(value),print:()=>{}});
 await lease('expired-job',1);await run(['context','expired-job']);await assert.rejects(()=>run(['plan','expired-job'],plan),/未确认/);
 const registry=path.join(root,'.liubai/accounts',accountKey,'plans',plan.entryId+'.json');assert.equal((await lstat(registry)).mode&0o777,0o600);await assert.rejects(()=>lstat(path.join(root,'.liubai/jobs/expired-job/plan-10000000-0000-4000-8000-000000000003.json')),{code:'ENOENT'});
 await lease('new-job',2);await run(['context','new-job']);const context=await readPrivateJSON(path.join(root,'.liubai/jobs/new-job/context.json'));assert.equal(context.frozenPlans[plan.entryId],registry);
 await assert.rejects(()=>run(['plan','new-job'],{...plan,summary:'new generated plan'}),/冻结/);assert.equal(submissions.length,1);
 const frozen=await readPrivateJSON(registry);await run(['plan','new-job'],frozen);assert.equal(submissions.length,2);assert.equal(submissions[1].summary,plan.summary);assert.equal(submissions[1].jobId,'new-job');
 await assert.rejects(()=>run(['plan','new-job'],{...frozen,source:'https://other.example'}),/绑定不匹配/);
});
test('only successful checkin with a verified processed snapshot removes frozen registry entries',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-frozen-clean-')),cfg=config(),full=snapshot(),accountKey=full.accountKey;
 full.tables.inbox_entries=[{owner:'owner-a',id:'processed-entry',body:'done input',state:'processed',summary:'done',plan_token:'server-frozen-token',created_at:'2026-01-01',processed_at:'2026-01-02'},{owner:'owner-a',id:'pending-entry',body:'pending input',state:'pending',summary:'',plan_token:null,created_at:'2026-01-01',processed_at:null}];full.counts.inbox_entries=2;
 await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);
 for(const entryId of ['processed-entry','pending-entry'])await writePrivateJSON(path.join(root,'.liubai/accounts',accountKey,'plans',entryId+'.json'),{format:'liubai-frozen-plan',version:1,source:cfg.url,accountKey,entryId,plan:{entryId,summary:'stable',changes:[]}});
 const fetchImpl=async(_url,options)=>JSON.parse(options.body).action==='snapshot'?Response.json(full):Response.json({ok:true});
 const run=args=>remoteMain(args,{root,fetchImpl,input:stream({result:'finished'}),print:()=>{}});
 async function lease(id){await writePrivateJSON(path.join(root,'.liubai/jobs',id,'lease.json'),{id,accountKey,generation:1,leaseToken:'private-lease',leaseUntil:'2030-01-01T00:00:00Z',state:'leased',source:cfg.url});}
 const registry=id=>path.join(root,'.liubai/accounts',accountKey,'plans',id+'.json');
 await lease('no-snapshot-job');await assert.rejects(()=>run(['checkin','no-snapshot-job']),/先 snapshot/);assert((await lstat(registry('processed-entry'))).isFile());
 await lease('failed-job');await run(['snapshot','failed-job']);await run(['fail','failed-job']);assert((await lstat(registry('processed-entry'))).isFile());
 await lease('successful-job');await run(['snapshot','successful-job']);await run(['checkin','successful-job']);await assert.rejects(()=>lstat(registry('processed-entry')),{code:'ENOENT'});assert((await lstat(registry('pending-entry'))).isFile());
});

test('invalid first plans never freeze or submit; corrected input can proceed',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-plan-validate-')),cfg=config(),accountKey='account-a',jobId='job-validation',entryId='10000000-0000-4000-8000-000000000004';
 await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);
 await writePrivateJSON(path.join(root,'.liubai/jobs',jobId,'lease.json'),{id:jobId,accountKey,generation:1,leaseToken:'private-token',leaseUntil:'2030-01-01T00:00:00Z',state:'leased',source:cfg.url});
 await writePrivateJSON(path.join(root,'.liubai/jobs',jobId,'context.json'),{jobId,accountKey,source:cfg.url,entries:[{id:entryId}],tasks:[]});
 const task={id:'new-task',title:'一个新任务',note:'',quadrant:1,category:'工作',due:'',urgencyMode:'auto',done:false,subtasks:[],revision:0},change={id:'20000000-0000-4000-8000-000000000001',kind:'create',task,reason:'原文明确要求',automatic:true},plan={entryId,summary:'整理了一项任务',changes:[change]},calls=[];
 const run=value=>remoteMain(['plan',jobId],{root,input:stream(value),print:()=>{},fetchImpl:async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({ok:true});}});
 const bad=[{...plan,summary:' '},{...plan,changes:[{...change,task:{...task,due:'2026-02-30'}}]},{...plan,changes:[{...change,task:{...task,category:'未知'}}]},{...plan,changes:[{...change,task:{...task,revision:1}}]},{...plan,changes:[change,{...change,task:{...task,id:'second-task'}}]},{...plan,changes:[change,{...change,id:'20000000-0000-4000-8000-000000000002',task:{...task,id:'second-task',title:'一个 新任务！'}}]},{...plan,changes:[{...change,task:{...task,done:true,subtasks:[{id:'step',title:'未完成步骤',done:false}]}}]}];
 for(const invalid of bad){await assert.rejects(()=>run(invalid));await assert.rejects(()=>lstat(path.join(root,'.liubai/accounts',accountKey,'plans',entryId+'.json')),{code:'ENOENT'});}
 assert.equal(calls.length,0);await run(plan);assert.equal(calls.length,1);await run(plan);assert.equal(calls.length,2);await assert.rejects(()=>run({...plan,summary:'另一份计划'}),/冻结/);assert.equal(calls.length,2);
});

test('Sites rename rebinds only after an exact redirect and valid machine queue, retaining frozen source bindings',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-relocate-')),old='https://old.author.chatgpt.site',next='https://new.author.chatgpt.site',cfg={...config(),url:old},accountKey='account-a',jobId='old-job',entryId='10000000-0000-4000-8000-000000000005',plan={entryId,summary:'原始计划',changes:[]},file=path.join(root,'.liubai/accounts',accountKey,'plans',entryId+'.json'),calls=[];
 await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);
 await writePrivateJSON(path.join(root,'.liubai/jobs',jobId,'lease.json'),{id:jobId,accountKey,generation:1,leaseToken:'private-token',leaseUntil:'2030-01-01T00:00:00Z',state:'leased',source:old});
 const original={format:'liubai-frozen-plan',version:1,source:old,accountKey,entryId,plan};await writePrivateJSON(file,original);
 const fetchImpl=async(url,options)=>{calls.push({url,redirect:options.redirect});if(url.startsWith(old))return new Response(null,{status:307,headers:{location:next+'/api/agent/jobs'}});const body=JSON.parse(options.body||'{}');if(body.action==='context')return Response.json({accountKey,jobId,entries:[{id:entryId}],tasks:[]});return Response.json(body.action==='plan'?{ok:true}:{accounts:[{accountKey,pendingEntries:1}],leaseSeconds:1200});};
 const run=(args,input={})=>remoteMain(args,{root,fetchImpl,input:stream(input),print:()=>{}});
 await assert.rejects(()=>run(['relocate','https://new.other.chatgpt.site']),/地址历史/);assert.equal(calls.length,0);
 await run(['relocate',next]);assert.deepEqual(calls.slice(0,2),[{url:old+'/api/agent/jobs',redirect:'manual'},{url:next+'/api/agent/jobs',redirect:'error'}]);
 const relocated=await readPrivateJSON(path.join(root,'.liubai/remote.json'));assert.equal(relocated.url,next);assert.deepEqual(relocated.previousOrigins,[old]);assert.equal(relocated.backupKey,cfg.backupKey);
 await run(['context',jobId]);await run(['plan',jobId],original);assert.deepEqual(await readPrivateJSON(file),original);assert(calls.slice(2).every(c=>c.url===next+'/api/agent/jobs'));
 const deniedRoot=await mkdtemp(path.join(os.tmpdir(),'liubai-relocate-denied-'));await writePrivateJSON(path.join(deniedRoot,'.liubai/remote.json'),cfg);
 for(const failure of ['different-redirect','denied-queue']){
  await assert.rejects(()=>remoteMain(['relocate',next],{root:deniedRoot,print:()=>{},fetchImpl:async(url)=>url.startsWith(old)?new Response(null,{status:307,headers:{location:(failure==='different-redirect'?old:next)+'/api/agent/jobs'}}):Response.json({},{status:401})}));
  assert.deepEqual(await readPrivateJSON(path.join(deniedRoot,'.liubai/remote.json')),cfg);
 }
});

test('checkin requires a bound snapshot, mutation invalidates it, and lost acknowledgements remain retriable',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'liubai-checkin-fence-')),cfg=config(),full=snapshot(),accountKey=full.accountKey,jobId='job-checkin',folder=path.join(root,'.liubai/jobs',jobId),calls=[];
 await writePrivateJSON(path.join(root,'.liubai/remote.json'),cfg);await writePrivateJSON(path.join(folder,'lease.json'),{id:jobId,accountKey,generation:1,leaseToken:'private-token',leaseUntil:'2030-01-01T00:00:00Z',state:'leased',source:cfg.url});
 let lose=true;const run=args=>remoteMain(args,{root,input:stream({result:'检查完成'}),print:()=>{},fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body.action);if(body.action==='snapshot')return Response.json(full);if(body.action==='checkin'&&lose){lose=false;throw Error('lost response');}return Response.json({ok:true});}});
 await assert.rejects(()=>run(['checkin',jobId]),/先 snapshot/);assert.equal(calls.length,0);
 await run(['snapshot',jobId]);const receipt=await readPrivateJSON(path.join(folder,'snapshot-receipt.json'));await writePrivateJSON(path.join(folder,'snapshot-receipt.json'),{...receipt,generation:2});await assert.rejects(()=>run(['checkin',jobId]),/绑定/);assert.equal(calls.length,1);
 await run(['snapshot',jobId]);await run(['resume',jobId]);await assert.rejects(()=>run(['checkin',jobId]),/先 snapshot/);assert(!calls.includes('checkin'));
 await run(['snapshot',jobId]);await assert.rejects(()=>run(['checkin',jobId]),/未确认/);assert.equal((await readPrivateJSON(path.join(folder,'lease.json'))).state,'leased');await run(['checkin',jobId]);await run(['checkin',jobId]);assert.equal(calls.filter(action=>action==='checkin').length,3);assert.equal((await readPrivateJSON(path.join(folder,'lease.json'))).snapshotVerified,true);
});
