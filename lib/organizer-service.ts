import {database} from './database';
import {defaultProfile,profileSchema,planSchema,safeAppend,normalizedTitle} from './organizer';
import type {Profile,RemoteGrant,Entry} from './organizer';
import type {Task} from './tasks';

export class OrganizerConflict extends Error {
 constructor(message:string,public code='CONFLICT'){super(message)}
}
export type LeaseGuard={owner:string;jobId:string;generation:number;tokenHash:string};
export type ChangeRow={owner:string;id:string;entry_id:string;kind:string;before_data:string|null;after_data:string;reason:string;automatic:number;state:string;created_at:string;decided_at:string|null};
type ProfileRow={data:string;revision:number;last_check:string|null;last_result:string};
export type GrantRow={owner:string;account_key:string;enabled:number;backup_enabled:number;generation:number;updated_at:string};

// The guard is repeated inside every final SQL transaction. A prior read is never
// sufficient authorization: revoking a grant fences out already-running jobs.
export function leaseCondition(lease?:LeaseGuard,backup=false){
 return lease?{sql:`EXISTS (SELECT 1 FROM agent_jobs j JOIN organizer_grants g ON g.owner=j.owner WHERE j.id=? AND j.owner=? AND j.generation=? AND j.token_hash=? AND j.state='leased' AND julianday(j.lease_until)>julianday('now') AND g.enabled=1 AND g.generation=j.generation${backup?' AND g.backup_enabled=1':''})`,values:[lease.jobId,lease.owner,lease.generation,lease.tokenHash]}:{sql:'1=1',values:[]};
}
export async function ensureProfile(owner:string,lease?:LeaseGuard){
 const gate=leaseCondition(lease);
 await database().prepare(`INSERT OR IGNORE INTO organizer_profiles (owner,data) SELECT ?,? WHERE ${gate.sql}`).bind(owner,JSON.stringify(defaultProfile),...gate.values).run();
}
export function grantView(row:GrantRow|null):RemoteGrant{return {enabled:row?.enabled===1,backupEnabled:row?.backup_enabled===1,generation:row?.generation??0,updatedAt:row?.updated_at??null}}
export function readProfile(row:ProfileRow|null,grant:GrantRow|null):Profile{return {...profileSchema.parse(row?JSON.parse(row.data):defaultProfile),remoteEnabled:grant?.enabled===1}}
export async function organizerState(owner:string,local:boolean,full=false,lease?:LeaseGuard){
 const db=database(),gate=leaseCondition(lease),bind=[owner,...gate.values];
 const results=await db.batch([
  db.prepare(`SELECT id,body,state,summary,created_at,processed_at FROM inbox_entries WHERE owner=? AND ${gate.sql} ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,CASE WHEN state='pending' THEN created_at ELSE NULL END ASC,created_at DESC,id${full?'':' LIMIT 150'}`).bind(...bind),
  // Keep every pending decision and the complete results of the displayed inputs.
  db.prepare(`SELECT * FROM task_changes WHERE owner=? AND ${gate.sql}${full?'':` AND (state='pending' OR entry_id IN (SELECT id FROM inbox_entries WHERE owner=? ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,CASE WHEN state='pending' THEN created_at ELSE NULL END ASC,created_at DESC,id LIMIT 150))`} ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,created_at DESC,id`).bind(...bind,...(full?[]:[owner])),
  db.prepare(`SELECT * FROM organizer_profiles WHERE owner=? AND ${gate.sql}`).bind(...bind),
  db.prepare(`SELECT * FROM organizer_grants WHERE owner=? AND ${gate.sql}`).bind(...bind),
  db.prepare(`SELECT ${gate.sql} AS allowed`).bind(...gate.values),
 ]);
 if(!Number((results[4].results[0] as {allowed:number})?.allowed))throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 const p=(results[2].results[0] as ProfileRow|undefined)??null,g=(results[3].results[0] as GrantRow|undefined)??null;
 return {entries:results[0].results as Entry[],changes:(results[1].results as ChangeRow[]).map(({owner:_owner,before_data,after_data,...r})=>({...r,before:before_data?JSON.parse(before_data):null,after:JSON.parse(after_data)})),profile:readProfile(p,g),profileRevision:p?.revision??0,lastCheck:p?.last_check??null,lastResult:p?.last_result??'尚未检查',remoteGrant:grantView(g),local};
}
export async function updateGrant(owner:string,accountKey:string,enabled:boolean){
 const db=database(),now=new Date().toISOString();
 await db.batch([
  db.prepare(`INSERT INTO organizer_grants (owner,account_key,enabled,backup_enabled,generation,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(owner) DO UPDATE SET account_key=excluded.account_key,enabled=excluded.enabled,backup_enabled=excluded.backup_enabled,generation=organizer_grants.generation+CASE WHEN organizer_grants.enabled<>excluded.enabled THEN 1 ELSE 0 END,updated_at=excluded.updated_at`).bind(owner,accountKey,enabled?1:0,enabled?1:0,now),
  db.prepare(`UPDATE agent_jobs SET state='revoked',finished_at=? WHERE owner=? AND state='leased' AND NOT EXISTS (SELECT 1 FROM organizer_grants g WHERE g.owner=agent_jobs.owner AND g.enabled=1 AND g.generation=agent_jobs.generation)`).bind(now,owner),
 ]);
 return grantView(await db.prepare('SELECT * FROM organizer_grants WHERE owner=?').bind(owner).first<GrantRow>());
}
export async function applyChange(owner:string,id:string,automatic=false,lease?:LeaseGuard){
 const db=database(),c=await db.prepare('SELECT * FROM task_changes WHERE owner=? AND id=?').bind(owner,id).first<ChangeRow>();
 if(!c)throw new OrganizerConflict('找不到这项变更。');
 if(c.state==='applied')return;
 if(c.state!=='pending')throw new OrganizerConflict('这项变更已处理。');
 const task=JSON.parse(c.after_data) as Task,before=c.before_data?JSON.parse(c.before_data) as Task:null;
 // Recompute the safety boundary, even for an interrupted automatic proposal.
 if(automatic&&(!c.automatic||!(c.kind==='create'&&!task.done||c.kind==='update'&&before&&safeAppend(before,task))))throw new OrganizerConflict('这项变更需要用户确认。');
 const createRows=automatic&&c.kind==='create'?(await db.prepare('SELECT id,data,revision,deleted FROM tasks WHERE owner=? ORDER BY id').bind(owner).all<{id:string;data:string;revision:number;deleted:number}>()).results:null;
 if(createRows?.some(r=>r.id!==task.id&&normalizedTitle(JSON.parse(r.data).title)===normalizedTitle(task.title)))throw new OrganizerConflict('任务名称已有相同事项，请由用户确认。');
 // Freeze the versions used to check duplicate names before an automatic create.
 // Any concurrent manual addition/edit aborts this auto-write for user review.
 const createFence=createRows?`AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.owner=? AND NOT EXISTS(SELECT 1 FROM json_each(?) b WHERE json_extract(b.value,'$.id')=t.id AND json_extract(b.value,'$.revision')=t.revision AND json_extract(b.value,'$.deleted')=t.deleted)) AND (SELECT COUNT(*) FROM tasks WHERE owner=?)=?`:'';
 const createValues=createRows?[owner,JSON.stringify(createRows.map(({id,revision,deleted})=>({id,revision,deleted}))),owner,createRows.length]:[];
 const next={...task,revision:c.kind==='create'?0:task.revision+1},gate=leaseCondition(lease);
 const pending=`EXISTS (SELECT 1 FROM task_changes WHERE owner=? AND id=? AND state='pending'${automatic?' AND automatic=1':''})`;
 const safe=automatic?`AND COALESCE((SELECT json_extract(data,'$.autoSafe') FROM organizer_profiles WHERE owner=?),1)=1`:'';
 const safeValues=automatic?[owner]:[];
 const mutation=c.kind==='create'
  ?db.prepare(`INSERT OR IGNORE INTO tasks (owner,id,data,revision,deleted) SELECT ?,?,?,0,0 WHERE ${pending} AND ${gate.sql} ${safe} ${createFence}`).bind(owner,task.id,JSON.stringify(next),owner,id,...gate.values,...safeValues,...createValues)
  :c.kind==='delete'
  ?db.prepare(`UPDATE tasks SET deleted=1,revision=revision+1 WHERE owner=? AND id=? AND revision=? AND deleted=0 AND ${pending} AND ${gate.sql} ${safe}`).bind(owner,task.id,task.revision,owner,id,...gate.values,...safeValues)
  :db.prepare(`UPDATE tasks SET data=?,revision=revision+1 WHERE owner=? AND id=? AND revision=? AND deleted=0 AND ${pending} AND ${gate.sql} ${safe}`).bind(JSON.stringify(next),owner,task.id,task.revision,owner,id,...gate.values,...safeValues);
 const condition=c.kind==='delete'?'deleted=1 AND revision=?':'deleted=0 AND revision=? AND data=?';
 const exact=c.kind==='delete'?[next.revision]:[next.revision,JSON.stringify(next)];
 const outcomes=await db.batch([
  mutation,
  db.prepare(`UPDATE task_changes SET state='applied',decided_at=? WHERE owner=? AND id=? AND state='pending' AND ${gate.sql} ${safe} AND EXISTS (SELECT 1 FROM tasks WHERE owner=? AND id=? AND ${condition})`).bind(new Date().toISOString(),owner,id,...gate.values,...safeValues,owner,task.id,...exact),
  db.prepare(`SELECT ${gate.sql} AS allowed`).bind(...gate.values),
 ]);
 if(!Number((outcomes[2].results[0] as {allowed:number})?.allowed))throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 const result=await db.prepare('SELECT state FROM task_changes WHERE owner=? AND id=?').bind(owner,id).first<{state:string}>();
 if(result?.state!=='applied')throw new OrganizerConflict('任务或整理偏好已经变化。请保留当前任务；需要修改时，把最新要求重新放入收件箱。');
}
export async function resumeAutomatic(owner:string,lease?:LeaseGuard){
 const db=database(),gate=leaseCondition(lease);
 const rows=await db.prepare(`SELECT id FROM task_changes WHERE owner=? AND state='pending' AND automatic=1 AND ${gate.sql} ORDER BY created_at,id`).bind(owner,...gate.values).all<{id:string}>();
 const errors:{id:string;error:string}[]=[];
 for(const r of rows.results)try{await applyChange(owner,r.id,true,lease)}catch(e){
  if(!(e instanceof OrganizerConflict)||e.code==='LEASE_LOST')throw e;
  await db.prepare(`UPDATE task_changes SET automatic=0 WHERE owner=? AND id=? AND state='pending' AND ${gate.sql}`).bind(owner,r.id,...gate.values).run();
  errors.push({id:r.id,error:e.message});
 }
 return {ok:true,errors};
}
async function planReceipt(owner:string,entryId:string,lease?:LeaseGuard){
 const db=database(),gate=leaseCondition(lease);
 const results=await db.batch([
  db.prepare(`SELECT id,plan_token,summary,processed_at FROM inbox_entries WHERE owner=? AND id=? AND ${gate.sql}`).bind(owner,entryId,...gate.values),
  db.prepare(`SELECT id FROM task_changes WHERE owner=? AND entry_id=? AND ${gate.sql} ORDER BY id`).bind(owner,entryId,...gate.values),
  db.prepare(`SELECT ${gate.sql} AS allowed`).bind(...gate.values),
 ]);
 if(!Number((results[2].results[0] as {allowed:number})?.allowed))throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 const entry=results[0].results[0] as {id:string;plan_token:string;summary:string;processed_at:string}|undefined;
 return {entryId:entry?.id,planToken:entry?.plan_token,summary:entry?.summary,processedAt:entry?.processed_at,changeIds:(results[1].results as {id:string}[]).map(c=>c.id)};
}
export async function savePlan(owner:string,input:unknown,lease?:LeaseGuard){
 const db=database(),plan=planSchema.parse(input),gate=leaseCondition(lease);
 const entry=await db.prepare('SELECT state,plan_token FROM inbox_entries WHERE owner=? AND id=?').bind(owner,plan.entryId).first<{state:string;plan_token:string|null}>();
 if(!entry)throw new OrganizerConflict('输入不存在。','ENTRY_NOT_FOUND');
 if(entry.state!=='pending')return {alreadyProcessed:true,receipt:await planReceipt(owner,plan.entryId,lease)};
 if(new Set(plan.changes.map(c=>c.id)).size!==plan.changes.length||new Set(plan.changes.map(c=>c.task.id)).size!==plan.changes.length)throw new OrganizerConflict('同一批次不能重复修改一项任务。');
 const [current,p]=await Promise.all([
  db.prepare('SELECT id,data,revision,deleted FROM tasks WHERE owner=?').bind(owner).all<{id:string;data:string;revision:number;deleted:number}>(),
  db.prepare('SELECT * FROM organizer_profiles WHERE owner=?').bind(owner).first<ProfileRow>(),
 ]);
 const titles=plan.changes.filter(c=>c.kind==='create').map(c=>normalizedTitle(c.task.title));
 if(new Set(titles).size!==titles.length)throw new OrganizerConflict('这份计划含重名新任务，请合并后重试。');
 const profile=p?profileSchema.parse(JSON.parse(p.data)):defaultProfile,token=crypto.randomUUID(),now=new Date().toISOString();
 const prepared=plan.changes.map(c=>{
  if(c.kind!=='delete'&&c.task.done&&c.task.subtasks.some(s=>!s.done))throw new OrganizerConflict('已完成任务不能包含未完成步骤；请提出恢复为待办的建议。');
  const row=current.results.find(r=>r.id===c.task.id),before=row?{...JSON.parse(row.data),revision:row.revision} as Task:null;
  if(c.kind==='create'&&(row||c.task.revision!==0))throw new OrganizerConflict('新任务标识已存在，或版本号无效。');
  const unavailable=c.kind!=='create'&&(!row||!!row.deleted);
  const stale=c.kind!=='create'&&!!row&&row.revision!==c.task.revision;
  const duplicate=c.kind==='create'&&current.results.some(r=>normalizedTitle(JSON.parse(r.data).title)===normalizedTitle(c.task.title));
  const automatic=!unavailable&&!stale&&profile.autoSafe&&c.automatic&&!duplicate&&(c.kind==='create'&&!c.task.done||c.kind==='update'&&before&&safeAppend(before,c.task));
  // Freeze the original suggestion once. A changed task requires a decision,
  // and a deleted target becomes history; neither can block the next input.
  const task=c.kind==='delete'&&before?before:before?{...c.task,revision:before.revision}:c.task;
  const reason=c.reason+(unavailable?'\n目标任务已删除或不存在，此建议已失效。':stale?'\n任务在整理期间已修改，请核对当前版本与原建议。':'');
  return {...c,task,before,reason,automatic:automatic?1:0,state:unavailable?'superseded':'pending'};
 });
 // A remote account is processed serially: interrupted safe operations precede
 // the oldest pending input. The conditions also run in the freeze transaction.
 const order=lease?`AND NOT EXISTS (SELECT 1 FROM task_changes WHERE owner=? AND state='pending' AND automatic=1) AND id=(SELECT id FROM inbox_entries WHERE owner=? AND state='pending' ORDER BY created_at,id LIMIT 1)`:'';
 const outcomes=await db.batch([
  db.prepare(`UPDATE inbox_entries SET state='processed',plan_token=?,summary=?,processed_at=? WHERE owner=? AND id=? AND state='pending' AND ${gate.sql} ${order}`).bind(token,plan.summary,now,owner,plan.entryId,...gate.values,...(lease?[owner,owner]:[])),
  ...prepared.map(c=>db.prepare(`INSERT INTO task_changes (owner,id,entry_id,kind,before_data,after_data,reason,automatic,state,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM inbox_entries WHERE owner=? AND id=? AND plan_token=?) AND ${gate.sql}`).bind(owner,c.id,plan.entryId,c.kind,c.before?JSON.stringify(c.before):null,JSON.stringify(c.task),c.reason,c.automatic,c.state,now,owner,plan.entryId,token,...gate.values)),
  db.prepare(`INSERT OR IGNORE INTO spaces (owner,initialized) SELECT ?,1 WHERE EXISTS (SELECT 1 FROM inbox_entries WHERE owner=? AND id=? AND plan_token=?) AND ${gate.sql}`).bind(owner,owner,plan.entryId,token,...gate.values),
  db.prepare(`SELECT ${gate.sql} AS allowed`).bind(...gate.values),
 ]);
 if(!Number((outcomes.at(-1)!.results[0] as {allowed:number})?.allowed))throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 const winner=await db.prepare('SELECT plan_token,state FROM inbox_entries WHERE owner=? AND id=?').bind(owner,plan.entryId).first<{plan_token:string;state:string}>();
 if(winner?.state==='pending')throw new OrganizerConflict('请先恢复中断的自动变更，再按输入创建时间依次整理。','QUEUE_ORDER');
 if(winner?.plan_token===token)for(const c of prepared.filter(c=>c.automatic))try{await applyChange(owner,c.id,true,lease)}catch(e){
  if(!(e instanceof OrganizerConflict)||e.code==='LEASE_LOST')throw e;
  await db.prepare(`UPDATE task_changes SET automatic=0 WHERE owner=? AND id=? AND state='pending' AND ${gate.sql}`).bind(owner,c.id,...gate.values).run();
 }
 return {alreadyProcessed:winner?.plan_token!==token,receipt:await planReceipt(owner,plan.entryId,lease)};
}
export async function organizerCheckin(owner:string,result:string,lease?:LeaseGuard){
 await ensureProfile(owner,lease);
 const gate=leaseCondition(lease);
 const r=await database().prepare(`UPDATE organizer_profiles SET last_check=?,last_result=? WHERE owner=? AND ${gate.sql}`).bind(new Date().toISOString(),result,owner,...gate.values).run();
 if(!r.meta.changes)throw new OrganizerConflict('租约已过期或授权已撤销。','LEASE_LOST');
 return {ok:true};
}
