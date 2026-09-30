import {z} from 'zod';
import {database} from './database';
import {OrganizerConflict,leaseCondition,organizerState,resumeAutomatic,savePlan,ensureProfile} from './organizer-service';
import type {GrantRow,LeaseGuard} from './organizer-service';
import {accountKey as ownerAccountKey} from './account';
import {createSnapshot} from './snapshot';

export const LEASE_SECONDS=1200;
type JobRow={id:string;owner:string;request_id:string;generation:number;token_hash:string;lease_until:string;state:string;created_at:string;finished_at:string|null;result:string};
export const leaseInput=z.object({jobId:z.string().uuid(),generation:z.number().int().min(1),leaseToken:z.string().min(32).max(200)});
export async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function validMachineToken(header:string|null,expectedHash:string|undefined){
 if(!expectedHash||! /^[a-f0-9]{64}$/i.test(expectedHash)||!header?.startsWith('Bearer '))return false;
 const token=header.slice(7);
 if(token.length<32||token.length>4096||/\s/.test(token))return false;
 const actual=await sha256(token),expected=expectedHash.toLowerCase();let mismatch=0;
 for(let i=0;i<64;i++)mismatch|=actual.charCodeAt(i)^expected.charCodeAt(i);
 return mismatch===0;
}
function publicJob(row:JobRow,accountKey:string,leaseToken?:string){return {id:row.id,accountKey,generation:row.generation,leaseUntil:row.lease_until,state:row.state,createdAt:row.created_at,finishedAt:row.finished_at,result:row.result,...(leaseToken?{leaseToken}:{})}}
export async function agentQueue(){
 const rows=await database().prepare(`SELECT g.account_key,g.generation,(SELECT COUNT(*) FROM inbox_entries e WHERE e.owner=g.owner AND e.state='pending') AS pending_entries,(SELECT COUNT(*) FROM task_changes c WHERE c.owner=g.owner AND c.state='pending' AND c.automatic=1) AS automatic_pending,p.last_check,p.last_result,EXISTS(SELECT 1 FROM agent_jobs j WHERE j.owner=g.owner AND j.state='leased' AND julianday(j.lease_until)>julianday('now') AND j.generation=g.generation) AS leased FROM organizer_grants g LEFT JOIN organizer_profiles p ON p.owner=g.owner WHERE g.enabled=1 ORDER BY g.account_key`).all<{account_key:string;generation:number;pending_entries:number;automatic_pending:number;last_check:string|null;last_result:string|null;leased:number}>();
 return {accounts:rows.results.map(r=>({accountKey:r.account_key,generation:r.generation,pendingEntries:r.pending_entries,automaticPending:r.automatic_pending,lastCheck:r.last_check,lastResult:r.last_result??'尚未检查',leased:!!r.leased})),leaseSeconds:LEASE_SECONDS};
}
export async function claimJob(input:unknown,machineHash:string){
 const {accountKey,requestId}=z.object({accountKey:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.string().uuid()}).parse(input);
 const db=database(),grant=await db.prepare('SELECT * FROM organizer_grants WHERE account_key=? AND enabled=1').bind(accountKey).first<GrantRow>();
 if(!grant)throw new OrganizerConflict('此账号未授权远程整理。','GRANT_REQUIRED');
 // Deterministic per-request secret makes a lost claim response retriable without
 // persisting a plaintext bearer token in D1 or granting two simultaneous jobs.
 const token=await sha256(`liubai-lease-v1:${machineHash.toLowerCase()}:${accountKey}:${grant.generation}:${requestId}`),hash=await sha256(token),id=crypto.randomUUID(),now=new Date().toISOString(),until=new Date(Date.now()+LEASE_SECONDS*1000).toISOString();
 await db.batch([
  db.prepare(`UPDATE agent_jobs SET state='expired',finished_at=? WHERE owner=? AND state='leased' AND julianday(lease_until)<=julianday('now') AND EXISTS(SELECT 1 FROM organizer_grants g WHERE g.owner=agent_jobs.owner AND g.enabled=1 AND g.generation=?)`).bind(now,grant.owner,grant.generation),
  db.prepare(`INSERT INTO agent_jobs (id,owner,request_id,generation,token_hash,lease_until,state,created_at) SELECT ?,owner,?,?,?,?,'leased',? FROM organizer_grants WHERE account_key=? AND enabled=1 AND generation=? AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE owner=organizer_grants.owner AND state='leased' AND julianday(lease_until)>julianday('now')) AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE owner=organizer_grants.owner AND request_id=? AND generation=organizer_grants.generation)`).bind(id,requestId,grant.generation,hash,until,now,accountKey,grant.generation,requestId),
 ]);
 const row=await db.prepare(`SELECT j.* FROM agent_jobs j JOIN organizer_grants g ON g.owner=j.owner WHERE j.owner=? AND j.request_id=? AND j.token_hash=? AND j.generation=? AND g.enabled=1 AND g.generation=j.generation`).bind(grant.owner,requestId,hash,grant.generation).first<JobRow>();
 if(!row)throw new OrganizerConflict('此账号已有整理任务，或授权已变化。','ACCOUNT_BUSY');
 if(row.state!=='leased'||Date.parse(row.lease_until)<=Date.now())throw new OrganizerConflict('此前租约已经结束，请使用新的requestId。','LEASE_LOST');
 return {job:publicJob(row,accountKey,token)};
}
export async function resolveLease(input:unknown){
 const parsed=leaseInput.parse(input),hash=await sha256(parsed.leaseToken),db=database();
 const job=await db.prepare(`SELECT j.* FROM agent_jobs j JOIN organizer_grants g ON g.owner=j.owner WHERE j.id=? AND j.generation=? AND j.token_hash=? AND j.state='leased' AND julianday(j.lease_until)>julianday('now') AND g.enabled=1 AND g.generation=j.generation`).bind(parsed.jobId,parsed.generation,hash).first<JobRow>();
 if(!job)throw new OrganizerConflict('租约已过期或授权已撤销，请重新读取队列。','LEASE_LOST');
 const lease:LeaseGuard={owner:job.owner,jobId:job.id,generation:job.generation,tokenHash:hash};
 return {lease,job,accountKey:await ownerAccountKey(job.owner)};
}
async function renewJob(input:unknown){
 const {lease,accountKey}=await resolveLease(input),gate=leaseCondition(lease),until=new Date(Date.now()+LEASE_SECONDS*1000).toISOString(),db=database();
 const results=await db.batch([
  db.prepare(`UPDATE agent_jobs SET lease_until=? WHERE id=? AND ${gate.sql}`).bind(until,lease.jobId,...gate.values),
  db.prepare(`SELECT * FROM agent_jobs WHERE id=? AND ${gate.sql}`).bind(lease.jobId,...gate.values),
 ]);
 const row=results[1].results[0] as JobRow|undefined;
 if(!row)throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 return {job:publicJob(row,accountKey,leaseInput.parse(input).leaseToken)};
}
export async function jobContext(input:unknown){
 const {lease,job,accountKey}=await resolveLease(input),gate=leaseCondition(lease),db=database();
 const [state,rows]=await Promise.all([
  organizerState(lease.owner,false,true,lease),
  db.prepare(`SELECT data,revision FROM tasks WHERE owner=? AND deleted=0 AND ${gate.sql} ORDER BY id`).bind(lease.owner,...gate.values).all<{data:string;revision:number}>(),
 ]);
 return {jobId:job.id,accountKey,now:new Date().toISOString(),timezone:state.profile.timezone,profile:state.profile,profileRevision:state.profileRevision,entries:state.entries.filter(e=>e.state==='pending').sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.id).localeCompare(String(b.id))),pendingChanges:state.changes.filter(c=>c.state==='pending'),tasks:rows.results.map(r=>({...JSON.parse(r.data),revision:r.revision})),lastCheck:state.lastCheck,lastResult:state.lastResult};
}
async function finishJob(input:unknown,failed:boolean){
 const parsed=leaseInput.extend({result:z.string().max(500)}).parse(input),hash=await sha256(parsed.leaseToken),db=database(),state=failed?'failed':'complete';
 // A finished receipt remains retriable with the same result; it cannot be used
 // to obtain another owner or to continue writing after the job finishes.
 const completed=await db.prepare(`SELECT j.* FROM agent_jobs j JOIN organizer_grants g ON g.owner=j.owner WHERE j.id=? AND j.generation=? AND j.token_hash=? AND j.state=? AND j.result=? AND g.enabled=1 AND g.generation=j.generation`).bind(parsed.jobId,parsed.generation,hash,state,parsed.result).first<JobRow>();
 if(completed)return {ok:true,alreadyFinished:true,job:publicJob(completed,await ownerAccountKey(completed.owner))};
 const {lease,accountKey}=await resolveLease(parsed),gate=leaseCondition(lease),now=new Date().toISOString();
 await ensureProfile(lease.owner,lease);
 const results=await db.batch([
  db.prepare(`UPDATE organizer_profiles SET last_check=?,last_result=? WHERE owner=? AND ${gate.sql}`).bind(now,parsed.result,lease.owner,...gate.values),
  db.prepare(`UPDATE agent_jobs SET state=?,finished_at=?,result=? WHERE id=? AND ${gate.sql}`).bind(state,now,parsed.result,lease.jobId,...gate.values),
 ]);
 if(!results[1].meta.changes)throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 const job=await db.prepare('SELECT * FROM agent_jobs WHERE id=?').bind(lease.jobId).first<JobRow>();
 return {ok:true,job:publicJob(job!,accountKey)};
}
export async function agentAction(body:Record<string,unknown>,machineHash:string){
 if(body.action==='claim')return claimJob(body,machineHash);
 if(body.action==='renew')return renewJob(body);
 if(body.action==='context')return jobContext(body);
 if(body.action==='checkin'||body.action==='fail')return finishJob(body,body.action==='fail');
 const {lease,job,accountKey}=await resolveLease(body);
 if(body.action==='plan')return savePlan(lease.owner,{action:'plan',entryId:body.entryId,summary:body.summary,changes:body.changes},lease);
 if(body.action==='resume')return resumeAutomatic(lease.owner,lease);
 if(body.action==='status')return {job:publicJob(job,accountKey),accountKey,...await organizerState(lease.owner,false,true,lease)};
 if(body.action==='snapshot')return createSnapshot(lease.owner,lease);
 throw new OrganizerConflict('未知操作。','UNKNOWN_ACTION');
}
