import {z} from 'zod';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {database} from '@/lib/database';
import {defaultProfile,profileSchema,planSchema,safeAppend,normalizedTitle} from '@/lib/organizer';
import type {Task} from '@/lib/tasks';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
class Conflict extends Error{}
type Row={id:string;entry_id:string;kind:string;before_data:string|null;after_data:string;reason:string;automatic:number;state:string;created_at:string;decided_at:string|null};
async function ensureProfile(owner:string){await database().prepare('INSERT OR IGNORE INTO organizer_profiles (owner,data) VALUES (?,?)').bind(owner,JSON.stringify(defaultProfile)).run();}
async function state(owner:string,local:boolean){const db=database();const [entries,changes,profile]=await Promise.all([
 db.prepare("SELECT id,body,state,summary,created_at,processed_at FROM inbox_entries WHERE owner=? ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,CASE WHEN state='pending' THEN created_at ELSE NULL END ASC,created_at DESC LIMIT 150").bind(owner).all(),
 db.prepare("SELECT * FROM task_changes WHERE owner=? ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 400").bind(owner).all<Row>(),
 db.prepare('SELECT * FROM organizer_profiles WHERE owner=?').bind(owner).first<{data:string;revision:number;last_check:string|null;last_result:string}>()
]);return {entries:entries.results,changes:changes.results.map(({owner:_owner,before_data,after_data,...r}:Row&{owner?:string})=>({...r,before:before_data?JSON.parse(before_data):null,after:JSON.parse(after_data)})),profile:profile?JSON.parse(profile.data):defaultProfile,profileRevision:profile?.revision??0,lastCheck:profile?.last_check??null,lastResult:profile?.last_result??'尚未检查',local};}
async function apply(owner:string,id:string,automatic=false){
 const db=database();const c=await db.prepare('SELECT * FROM task_changes WHERE owner=? AND id=?').bind(owner,id).first<Row>();
 if(!c)throw new Conflict('找不到这项变更。');if(automatic){const p=await db.prepare('SELECT data FROM organizer_profiles WHERE owner=?').bind(owner).first<{data:string}>();if(p&&!JSON.parse(p.data).autoSafe)throw new Conflict('当前偏好要求逐条确认。');}if(c.state==='applied')return;if(c.state!=='pending')throw new Conflict('这项变更已处理。');
 const task=JSON.parse(c.after_data) as Task;const before=c.before_data?JSON.parse(c.before_data) as Task:null;const next={...task,revision:c.kind==='create'?0:task.revision+1};
 const exists="EXISTS (SELECT 1 FROM task_changes WHERE owner=? AND id=? AND state='pending')";
 const change=c.kind==='create'
 ?db.prepare(`INSERT OR IGNORE INTO tasks (owner,id,data,revision,deleted) SELECT ?,?,?,0,0 WHERE ${exists}`).bind(owner,task.id,JSON.stringify(next),owner,id)
 :c.kind==='delete'
 ?db.prepare(`UPDATE tasks SET deleted=1,revision=revision+1 WHERE owner=? AND id=? AND revision=? AND deleted=0 AND ${exists}`).bind(owner,task.id,task.revision,owner,id)
 :db.prepare(`UPDATE tasks SET data=?,revision=revision+1 WHERE owner=? AND id=? AND revision=? AND deleted=0 AND ${exists}`).bind(JSON.stringify(next),owner,task.id,task.revision,owner,id);
 // Both statements run in one transaction. An outdated task leaves the proposal pending.
 const condition=c.kind==='delete'?'deleted=1 AND revision=? AND data=?':'deleted=0 AND revision=? AND data=?';
 const exactData=c.kind==='delete'?JSON.stringify(before):JSON.stringify(next);
 await db.batch([change,db.prepare(`UPDATE task_changes SET state='applied',decided_at=? WHERE owner=? AND id=? AND state='pending' AND EXISTS (SELECT 1 FROM tasks WHERE owner=? AND id=? AND ${condition})`).bind(new Date().toISOString(),owner,id,owner,task.id,next.revision,exactData)]);
 const result=await db.prepare('SELECT state FROM task_changes WHERE owner=? AND id=?').bind(owner,id).first<{state:string}>();
 if(result?.state!=='applied')throw new Conflict('任务已经变化。请保留当前任务；需要修改时，把最新要求重新放入收件箱。');
}
export async function GET(){try{const u=await getChatGPTUser();if(!u)return reply({error:'请先登录。'},401);return reply(await state(u.userId,u.local));}catch(e){console.error('organizer read',String(e));return reply({error:'收件箱暂时无法连接，请稍后重试。'},503);}}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&new URL(origin).host!==new URL(request.url).host)return reply({error:'请求来源不匹配。'},403);
 const u=await getChatGPTUser();if(!u)return reply({error:'请先登录。'},401);const owner=u.userId,db=database();const body=z.record(z.unknown()).parse(await request.json());
 if(body.action==='submit'){
  const id=z.string().uuid().parse(body.id),text=z.string().trim().min(1).max(20000).parse(body.text);
  await db.prepare("INSERT OR IGNORE INTO inbox_entries (owner,id,body,created_at) VALUES (?,?,?,?)").bind(owner,id,text,new Date().toISOString()).run();
  const saved=await db.prepare('SELECT body FROM inbox_entries WHERE owner=? AND id=?').bind(owner,id).first<{body:string}>();if(saved?.body!==text)throw new Conflict('这份输入已保存，请刷新后查看，或提交为新的一份。');return reply({id});
 }
 if(body.action==='profile'){
  await ensureProfile(owner);const profile=profileSchema.parse(body.profile),revision=z.number().int().min(0).parse(body.revision);
  const r=await db.prepare('UPDATE organizer_profiles SET data=?,revision=revision+1 WHERE owner=? AND revision=?').bind(JSON.stringify(profile),owner,revision).run();if(!r.meta.changes)throw new Conflict('整理偏好已变化，请重新载入后修改。');return reply({profile,revision:revision+1});
 }
 if(body.action==='decide'){
  const id=z.string().uuid().parse(body.id);const decision=z.enum(['accept','dismiss']).parse(body.decision);
  if(decision==='accept')await apply(owner,id);else await db.prepare("UPDATE task_changes SET state='dismissed',decided_at=? WHERE owner=? AND id=? AND state='pending'").bind(new Date().toISOString(),owner,id).run();return reply(await state(owner,u.local));
 }
 // The local Codex worker cannot act on anyone's cloud account.
 if(!u.local)return reply({error:'自动整理目前只连接本地空间。'},403);
 if(body.action==='checkin'){
  await ensureProfile(owner);await db.prepare('UPDATE organizer_profiles SET last_check=?,last_result=? WHERE owner=?').bind(new Date().toISOString(),z.string().max(500).parse(body.result),owner).run();return reply({ok:true});
 }
 if(body.action==='resume'){
  const rows=await db.prepare("SELECT id FROM task_changes WHERE owner=? AND state='pending' AND automatic=1").bind(owner).all<{id:string}>();const errors=[];
  for(const r of rows.results)try{await apply(owner,r.id,true)}catch(e){if(!(e instanceof Conflict))throw e;await db.prepare('UPDATE task_changes SET automatic=0 WHERE owner=? AND id=?').bind(owner,r.id).run();errors.push({id:r.id,error:e.message})}return reply({ok:true,errors});
 }
 if(body.action==='plan'){
  const plan=planSchema.parse(body);const entry=await db.prepare('SELECT state,plan_token FROM inbox_entries WHERE owner=? AND id=?').bind(owner,plan.entryId).first<{state:string;plan_token:string|null}>();if(!entry)return reply({error:'输入不存在。'},404);
  if(entry.state!=='pending')return reply({alreadyProcessed:true,...await state(owner,true)});
  if(new Set(plan.changes.map(c=>c.id)).size!==plan.changes.length||new Set(plan.changes.map(c=>c.task.id)).size!==plan.changes.length)throw new Conflict('同一批次不能重复修改一项任务。');
  const [current,p]=await Promise.all([db.prepare('SELECT id,data,revision,deleted FROM tasks WHERE owner=?').bind(owner).all<{id:string;data:string;revision:number;deleted:number}>(),db.prepare('SELECT data FROM organizer_profiles WHERE owner=?').bind(owner).first<{data:string}>()]);
  const createTitles=plan.changes.filter(c=>c.kind==='create').map(c=>normalizedTitle(c.task.title));if(new Set(createTitles).size!==createTitles.length)throw new Conflict('这份计划含重名新任务，请合并后重试。');
  const profile=p?profileSchema.parse(JSON.parse(p.data)):defaultProfile;const token=crypto.randomUUID(),now=new Date().toISOString();
  const prepared=plan.changes.map(c=>{if(c.kind!=='delete'&&c.task.done&&c.task.subtasks.some(s=>!s.done))throw new Conflict('已完成任务不能包含未完成步骤；请提出恢复为待办的建议。');const row=current.results.find(r=>r.id===c.task.id);const before=row?{...JSON.parse(row.data),revision:row.revision} as Task:null;
   if(c.kind==='create'&&(row||c.task.revision!==0))throw new Conflict('新任务标识已存在，或版本号无效。');
   if(c.kind!=='create'&&(!row||row.deleted||row.revision!==c.task.revision))throw new Conflict('任务已变化，请重新读取后整理。');
   const duplicate=c.kind==='create'&&current.results.some(r=>normalizedTitle(JSON.parse(r.data).title)===normalizedTitle(c.task.title));
   const automatic=profile.autoSafe&&c.automatic&&!duplicate&&(c.kind==='create'&&!c.task.done||c.kind==='update'&&before&&safeAppend(before,c.task));
   return {...c,task:c.kind==='delete'?before!:c.task,before,automatic:automatic?1:0};
  });
  await db.batch([db.prepare("UPDATE inbox_entries SET state='processed',plan_token=?,summary=?,processed_at=? WHERE owner=? AND id=? AND state='pending'").bind(token,plan.summary,now,owner,plan.entryId),...prepared.map(c=>db.prepare("INSERT INTO task_changes (owner,id,entry_id,kind,before_data,after_data,reason,automatic,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM inbox_entries WHERE owner=? AND id=? AND plan_token=?)").bind(owner,c.id,plan.entryId,c.kind,c.before?JSON.stringify(c.before):null,JSON.stringify(c.task),c.reason,c.automatic,now,owner,plan.entryId,token))]);
  const winner=await db.prepare('SELECT plan_token FROM inbox_entries WHERE owner=? AND id=?').bind(owner,plan.entryId).first<{plan_token:string}>();
  if(winner?.plan_token===token)for(const c of prepared.filter(c=>c.automatic))try{await apply(owner,c.id,true)}catch(e){if(!(e instanceof Conflict))throw e;await db.prepare('UPDATE task_changes SET automatic=0 WHERE owner=? AND id=?').bind(owner,c.id).run()}
  await db.prepare('INSERT OR IGNORE INTO spaces (owner,initialized) VALUES (?,1)').bind(owner).run();return reply(await state(owner,true));
 }
 return reply({error:'未知操作。'},400);
}catch(e){if(e instanceof z.ZodError||e instanceof SyntaxError)return reply({error:'内容格式不正确，请检查输入。'},400);if(e instanceof Conflict)return reply({error:e.message},409);console.error('organizer write',String(e));return reply({error:'写入未确认，请保留内容后重试。'},503);}}
