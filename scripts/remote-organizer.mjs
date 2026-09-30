#!/usr/bin/env node
import {randomBytes,randomUUID} from 'node:crypto';
import {lstat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupKey,canonical,digest,privateDir,readPrivateJSON,writePrivateJSON,saveSnapshot,pruneBackups} from './backups.mjs';
import {configureRemoteNetwork} from './remote-network.mjs';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));
const idPattern=/^[A-Za-z0-9_-]{1,160}$/;
function identifier(value){if(typeof value!=='string'||!idPattern.test(value))throw Error('账号或任务标识无效');return value;}
export function validateConfig(config){if(!config||typeof config!=='object'||Array.isArray(config))throw Error('远程配置格式无效');let url;try{url=new URL(config.url);}catch{throw Error('远程地址无效');}if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!['','/'].includes(url.pathname))throw Error('远程地址必须是没有路径、参数或凭据的HTTPS站点地址');if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('远程模式不使用本地地址');for(const field of ['sitesToken','agentToken'])if(typeof config[field]!=='string'||config[field].length<(field==='agentToken'?32:16)||config[field].length>16384||/\s/.test(config[field]))throw Error('远程凭据无效');backupKey(config.backupKey);return {url:url.origin,sitesToken:config.sitesToken,agentToken:config.agentToken,backupKey:config.backupKey};}
export async function readJSONInput(stream=process.stdin){if(stream.isTTY)throw Error('请通过不会回显的标准输入管道传入JSON，不要在终端直接键入凭据');let input='',bytes=0;for await(const part of stream){bytes+=Buffer.byteLength(part);if(bytes>512000)throw Error('输入超过大小限制');input+=part;}try{const parsed=JSON.parse(input);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed;}catch{throw Error('标准输入必须是单个JSON对象');}}
function nonJSONResponseError(response){
 const details=[`HTTP ${response.status}`],ray=response.headers.get('cf-ray'),mitigated=response.headers.get('cf-mitigated');
 // Only known, bounded Cloudflare diagnostics may reach logs; never echo HTML or arbitrary headers.
 if(typeof ray==='string'&&[16,20].includes(ray.length)&&/^[0-9a-f]{16}(?:-[A-Z]{3})?$/.test(ray))details.push(`cf-ray=${ray}`);
 if(mitigated==='challenge')details.push('cf-mitigated=challenge');
 return Error(`云端连接未确认（${details.join('；')}）；站点未返回 API 响应，请保留已有 job 与计划后重试`);
}
export function createRemoteClient(config,fetchImpl=fetch){config=validateConfig(config);return async(action,payload={})=>{let response;try{response=await fetchImpl(`${config.url}/api/agent/jobs`,{method:action==='queue'?'GET':'POST',headers:{'Content-Type':'application/json','OAI-Sites-Authorization':`Bearer ${config.sitesToken}`,Authorization:`Bearer ${config.agentToken}`},...(action==='queue'?{}:{body:JSON.stringify({...payload,action})}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw Error('远程请求未确认；保留当前job与计划后重试，不要新建重复任务');}if(!response.headers.get('content-type')?.includes('application/json'))throw nonJSONResponseError(response);let data;try{data=await response.json();}catch{throw Error('远程响应格式无效');}if(!response.ok){const error=Error(`远程操作未完成（HTTP ${response.status}）；请检查授权、租约或版本冲突`);if(['LEASE_LOST','ACCOUNT_BUSY','GRANT_REQUIRED'].includes(data.code))error.code=data.code;throw error;}return data;};}
function publicJob(job){return {jobId:job.id,accountKey:job.accountKey,generation:job.generation,leaseUntil:job.leaseUntil,state:job.state};}
function validateJob(job){identifier(job?.id);identifier(job?.accountKey);if(!Number.isInteger(job.generation)||job.generation<0||typeof job.leaseToken!=='string'||!job.leaseToken||typeof job.leaseUntil!=='string')throw Error('服务器job响应无效');return job;}
function safeAccount(account){return {accountKey:identifier(account.accountKey),pendingEntries:account.pendingEntries,automaticPending:account.automaticPending,lastCheck:account.lastCheck,leased:account.leased};}
function frozenPath(stateDir,accountKey,entryId){return path.join(stateDir,'accounts',identifier(accountKey),'plans',`${identifier(entryId)}.json`);}
function validateFrozen(value,source,accountKey,entryId){
 if(value?.format!=='liubai-frozen-plan'||value.version!==1||value.source!==source||value.accountKey!==accountKey||value.entryId!==entryId||value.plan?.entryId!==entryId)throw Error('冻结计划的站点或账号绑定不匹配');
 return value.plan;
}
async function frozenPaths(stateDir,entries,source,accountKey){
 const paths={};
 for(const entry of entries||[]){const file=frozenPath(stateDir,accountKey,entry.id);try{const stored=await readPrivateJSON(file);validateFrozen(stored,source,accountKey,entry.id);paths[entry.id]=file;}catch(error){if(error.code!=='ENOENT')throw error;}}
 return paths;
}
async function cleanCompletedPlans(stateDir,folder,lease,source){
 // This receipt exists only after an authorized full snapshot has been verified
 // and saved. A failed job or an entry still pending has no cleanup authority.
 const file=path.join(folder,'snapshot-receipt.json');let receipt;
 try{receipt=await readPrivateJSON(file);}catch(error){if(error.code==='ENOENT')return 0;throw error;}
 if(receipt.source!==source||receipt.accountKey!==lease.accountKey||receipt.jobId!==lease.id||receipt.generation!==lease.generation||!Array.isArray(receipt.processedEntryIds))throw Error('快照回执绑定不匹配');
 let removed=0;
 for(const entryId of receipt.processedEntryIds){const planFile=frozenPath(stateDir,lease.accountKey,entryId);try{validateFrozen(await readPrivateJSON(planFile),source,lease.accountKey,entryId);await unlink(planFile);removed++;}catch(error){if(error.code!=='ENOENT')throw error;}}
 await unlink(file);return removed;
}
export async function remoteMain(args=process.argv.slice(2),{root=projectRoot,fetchImpl=fetch,input=process.stdin,print=value=>console.log(JSON.stringify(value,null,2)),configureNetwork=configureRemoteNetwork}={}){const [command='help',argument,...rest]=args;const stateDir=path.join(root,'.liubai'),configFile=path.join(stateDir,'remote.json');
 if(command==='help'){print({commands:['init < 安全配置.json','prune','queue','claim <accountKey>','context <jobId>','renew <jobId>','plan <jobId> < 计划.json','resume <jobId>','fail <jobId> < {"result":"简短结果"}','checkin <jobId> < {"result":"简短结果"}','status <jobId>','snapshot <jobId>'],note:'仅HTTPS；账号原文写入权限受限的job文件，不输出正文或凭据。每次在线调度先prune再queue；已领取job可重试原计划；每次完成后checkin释放。'});return;}
 if(command==='prune'){print({ok:true,...await pruneBackups(path.join(stateDir,'backups'))});return;}
 if(command==='init'){const provided=await readJSONInput(input);const config=validateConfig({...provided,backupKey:provided.backupKey||randomBytes(32).toString('base64')});await privateDir(stateDir);try{await lstat(configFile);throw Error('远程配置已存在；为避免丢失备份密钥，不覆盖现有配置');}catch(e){if(e.code!=='ENOENT')throw e;}await writePrivateJSON(configFile,config,{exclusive:true});print({ok:true,configured:true});return;}
 const config=validateConfig(await readPrivateJSON(configFile)),client=createRemoteClient(config,fetchImpl);let networkReady;
 const api=async(...params)=>{if(fetchImpl===fetch)await(networkReady??=configureNetwork());return client(...params);};
 if(command==='queue'){const queue=await api('queue');if(!Array.isArray(queue.accounts))throw Error('远程账号列表无效');print({accounts:queue.accounts.map(safeAccount),leaseSeconds:queue.leaseSeconds});return;}
 if(command==='claim'){
  const accountKey=identifier(argument),requestFile=path.join(stateDir,'jobs',`claim-${digest(accountKey)}.json`);
  for(let attempt=0;attempt<2;attempt++){
   let saved;
   try{saved=await readPrivateJSON(requestFile);}catch(e){
    if(e.code!=='ENOENT')throw e;
    saved={accountKey,source:config.url,requestId:randomUUID()};
    try{await writePrivateJSON(requestFile,saved,{exclusive:true});}catch(error){if(error.code!=='EEXIST')throw error;saved=await readPrivateJSON(requestFile);}
   }
   if(saved.accountKey!==accountKey||saved.source!==config.url)throw Error('认领记录绑定不匹配');
   let response;
   try{response=await api('claim',{accountKey,requestId:saved.requestId});}catch(error){
    if(error.code!=='LEASE_LOST'||attempt)throw error;
    await unlink(requestFile).catch(e=>{if(e.code!=='ENOENT')throw e;});continue;
   }
   if(!response.job){print({claimed:false,accountKey});return;}
   const job=validateJob(response.job);
   if(job.accountKey!==accountKey)throw Error('认领返回了其他账号，未保存内容');
   if(job.state!=='leased'){
    if(attempt)throw Error('服务器未返回有效租约，请重新读取队列');
    await unlink(requestFile).catch(e=>{if(e.code!=='ENOENT')throw e;});continue;
   }
   await writePrivateJSON(path.join(stateDir,'jobs',job.id,'lease.json'),{...job,source:config.url});
   print({claimed:true,...publicJob(job)});return;
  }
 }
 const jobId=identifier(argument),folder=path.join(stateDir,'jobs',jobId),leaseFile=path.join(folder,'lease.json');const lease=validateJob(await readPrivateJSON(leaseFile));if(lease.id!==jobId||lease.source!==config.url)throw Error('job与配置站点不匹配');const auth={jobId,generation:lease.generation,leaseToken:lease.leaseToken};
 if(command==='context'||command==='status'){const result=await api(command,auth);if(result.accountKey&&result.accountKey!==lease.accountKey||result.jobId&&result.jobId!==jobId)throw Error('上下文账号不匹配');const file=path.join(folder,`${command}.json`),frozenPlans=command==='context'?await frozenPaths(stateDir,result.entries,config.url,lease.accountKey):undefined;await writePrivateJSON(file,{...result,accountKey:lease.accountKey,jobId,source:config.url,...(frozenPlans?{frozenPlans}:{})});print({ok:true,...publicJob(lease),contextFile:file,entries:result.entries?.length,tasks:result.tasks?.length,pendingChanges:result.pendingChanges?.length});return;}
 if(command==='renew'){const result=await api(command,auth),job=validateJob({...result.job,leaseToken:lease.leaseToken});if(job.id!==jobId||job.accountKey!==lease.accountKey||job.generation!==lease.generation)throw Error('续租账号或授权代次不匹配');await writePrivateJSON(leaseFile,{...job,source:config.url});print({ok:true,...publicJob(job)});return;}
 if(command==='plan'){
  const supplied=await readJSONInput(input),plan=supplied.format==='liubai-frozen-plan'?validateFrozen(supplied,config.url,lease.accountKey,supplied.entryId):supplied;
  if(Object.keys(plan).some(k=>!['entryId','summary','changes','action'].includes(k))||(plan.action&&plan.action!=='plan')||typeof plan.entryId!=='string'||typeof plan.summary!=='string'||!Array.isArray(plan.changes)||plan.changes.length>40)throw Error('计划格式无效');
  identifier(plan.entryId);const context=await readPrivateJSON(path.join(folder,'context.json'));
  if(context.accountKey!==lease.accountKey||context.jobId!==jobId||context.source!==config.url||!context.entries?.some(entry=>entry.id===plan.entryId))throw Error('计划输入不属于已领取的本账号上下文');
  const normalized={entryId:plan.entryId,summary:plan.summary,changes:plan.changes},file=frozenPath(stateDir,lease.accountKey,plan.entryId);
  const envelope={format:'liubai-frozen-plan',version:1,source:config.url,accountKey:lease.accountKey,entryId:plan.entryId,createdAt:new Date().toISOString(),plan:normalized};
  try{await writePrivateJSON(file,envelope,{exclusive:true});}catch(error){if(error.code!=='EEXIST')throw error;const stored=validateFrozen(await readPrivateJSON(file),config.url,lease.accountKey,plan.entryId);if(canonical(stored)!==canonical(normalized))throw Error('此输入已有冻结计划，请重试原计划，不要替换');}
  const result=await api(command,{...auth,...normalized});print({ok:true,jobId,accountKey:lease.accountKey,alreadyProcessed:result.alreadyProcessed===true});return;
 }
 if(command==='snapshot'){
  const result=await api(command,auth),snapshot=result.snapshot||result;if(snapshot.accountKey!==lease.accountKey)throw Error('快照账号不匹配');
  const saved=await saveSnapshot(snapshot,{directory:path.join(stateDir,'backups'),key:config.backupKey,source:config.url});
  const processedEntryIds=snapshot.tables.inbox_entries.filter(entry=>entry.state==='processed'&&typeof entry.plan_token==='string'&&entry.plan_token).map(entry=>identifier(entry.id));
  await writePrivateJSON(path.join(folder,'snapshot-receipt.json'),{version:1,source:config.url,accountKey:lease.accountKey,jobId,generation:lease.generation,businessHash:snapshot.businessHash,verifiedAt:new Date().toISOString(),processedEntryIds});
  print(saved);return;
 }
 if(command==='resume'){const result=await api(command,auth);print({ok:result.ok===true,jobId,accountKey:lease.accountKey,conflicts:Array.isArray(result.errors)?result.errors.length:0});return;}
 if(command==='checkin'||command==='fail'){
  const body=argument&&rest.length?{result:rest.join(' ')}:await readJSONInput(input);if(Object.keys(body).some(k=>k!=='result')||typeof body.result!=='string'||body.result.length>500)throw Error('结果必须是至多500字的JSON result');
  const finished=await api(command,{...auth,result:body.result});if(finished.ok!==true)throw Error('完成状态未确认；保留原计划和快照回执');
  await writePrivateJSON(leaseFile,{...lease,state:command==='fail'?'failed':'completed',source:config.url});
  let removedFrozenPlans=0,registryCleanupDeferred=false;if(command==='checkin')try{removedFrozenPlans=await cleanCompletedPlans(stateDir,folder,lease,config.url);}catch{registryCleanupDeferred=true;}
  await unlink(path.join(stateDir,'jobs',`claim-${digest(lease.accountKey)}.json`)).catch(e=>{if(e.code!=='ENOENT')throw e;});for(const file of ['context.json','status.json'])await unlink(path.join(folder,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  print({ok:true,jobId,accountKey:lease.accountKey,released:true,removedFrozenPlans,...(registryCleanupDeferred?{registryCleanupDeferred:true}:{})});return;
 }
 throw Error('未知远程命令');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))remoteMain().catch(error=>{console.error(error.message);process.exitCode=1;});
