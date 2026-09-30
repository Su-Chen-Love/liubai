import {z} from 'zod';
import {database} from './database';
import {accountKey} from './account';
import {taskSchema} from './task-schema';
import {normalizedTitle} from './organizer';
import type {Task} from './tasks';
const sourceSchema=z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const importSchema=z.object({batchId:z.string().uuid(),sourceId:sourceSchema,tasks:z.array(taskSchema).max(1000)});
type Row={id:string;data:string;revision:number;deleted:number};
type Item={sourceTaskId:string;task:Task;targetId?:string;reason?:string};
export type ImportPreview={id:string;accountKey:string;sourceId:string;createdAt:string;additions:Item[];duplicates:Item[];unchanged:Item[];base:{id:string;revision:number;deleted:number}[]};
function error(message:string,status=409){return Object.assign(new Error(message),{status});}
async function mappedId(source:string,id:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source+':'+id));return 'import-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
function content(t:Task){const {id:_id,revision:_revision,...rest}=t;return JSON.stringify({...rest,deadline:t.deadline||'',urgencyMode:t.urgencyMode||(t.quadrant%2===0?'manualUrgent':'manualNormal')});}
export async function previewImport(owner:string,input:unknown){
 const body=importSchema.parse(input),db=database();
 const existing=await db.prepare('SELECT data FROM task_imports WHERE owner=? AND id=?').bind(owner,body.batchId).first<{data:string}>();
 if(existing){const p=JSON.parse(existing.data) as ImportPreview;if(p.sourceId!==body.sourceId)throw error('这个导入批次已绑定另一份来源。');return p;}
 if(new Set(body.tasks.map(t=>t.id)).size!==body.tasks.length)throw error('来源任务 ID 重复。',400);
 const rows=(await db.prepare('SELECT id,data,revision,deleted FROM tasks WHERE owner=? ORDER BY id').bind(owner).all<Row>()).results;
 const prior=(await db.prepare("SELECT data FROM task_imports WHERE owner=? AND state='applied'").bind(owner).all<{data:string}>()).results.map(r=>JSON.parse(r.data) as ImportPreview);
 const p:ImportPreview={id:body.batchId,accountKey:await accountKey(owner),sourceId:body.sourceId,createdAt:new Date().toISOString(),additions:[],duplicates:[],unchanged:[],base:rows.map(({id,revision,deleted})=>({id,revision,deleted}))};
 for(const raw of body.tasks){
  const task={...raw,id:await mappedId(body.sourceId,raw.id),revision:0};
  const priorItem=prior.filter(x=>x.sourceId===body.sourceId).flatMap(x=>[...x.additions,...x.duplicates,...x.unchanged]).find(x=>x.sourceTaskId===raw.id);
  const target=rows.find(r=>r.id===(priorItem?.targetId||priorItem?.task.id||task.id))||rows.find(r=>normalizedTitle((JSON.parse(r.data) as Task).title)===normalizedTitle(raw.title));
  const item:Item={sourceTaskId:raw.id,task,...(target?{targetId:target.id}:{})};
  if(!target){p.additions.push(item);continue;}
  if(target.deleted){p.unchanged.push({...item,reason:'云端保留了删除记录，本次不恢复。'});continue;}
  if(content(JSON.parse(target.data))===content(raw)){p.unchanged.push({...item,reason:'云端已有相同事项，保留现有版本。'});continue;}
  p.duplicates.push({...item,reason:'名称或来源相同，日期、状态或内容需要你判断；本次不会覆盖。'});
 }
 await db.prepare("INSERT OR IGNORE INTO task_imports(owner,id,data,state,created_at,updated_at) VALUES (?,?,?,'preview',?,?)").bind(owner,p.id,JSON.stringify(p),p.createdAt,p.createdAt).run();
 return JSON.parse((await db.prepare('SELECT data FROM task_imports WHERE owner=? AND id=?').bind(owner,p.id).first<{data:string}>())!.data) as ImportPreview;
}
export async function applyImport(owner:string,batchId:string){
 z.string().uuid().parse(batchId);const db=database();
 const row=await db.prepare('SELECT data,state FROM task_imports WHERE owner=? AND id=?').bind(owner,batchId).first<{data:string;state:string}>();
 if(!row)throw error('请先生成导入预览。',404);const p=JSON.parse(row.data) as ImportPreview;
 if(row.state==='applied')return {imported:p.additions.length,pending:p.duplicates.length,replayed:true};
 if(p.accountKey!==await accountKey(owner))throw error('导入目标账号不匹配。');
 const current=(await db.prepare('SELECT id,revision,deleted FROM tasks WHERE owner=? ORDER BY id').bind(owner).all<{id:string;revision:number;deleted:number}>()).results;
 if(JSON.stringify(current)!==JSON.stringify(p.base))throw error('云端任务在预览后变化了。请用新的批次重新预览，保留当前修改。');
 // All writes share the same transaction. The fence checks the entire target
 // task version set again inside SQL, including tombstones and newly added IDs.
 const gate=`NOT EXISTS(SELECT 1 FROM tasks t WHERE t.owner=? AND NOT EXISTS(SELECT 1 FROM json_each(?) b WHERE json_extract(b.value,'$.id')=t.id AND json_extract(b.value,'$.revision')=t.revision AND json_extract(b.value,'$.deleted')=t.deleted)) AND (SELECT COUNT(*) FROM tasks WHERE owner=?)=?`;
 const statements=[db.prepare(`UPDATE task_imports SET state='applying' WHERE owner=? AND id=? AND state='preview' AND ${gate}`).bind(owner,batchId,owner,JSON.stringify(p.base),owner,p.base.length)];
 const appliedGate="EXISTS(SELECT 1 FROM task_imports WHERE owner=? AND id=? AND state='applying')";
 for(const item of p.additions)statements.push(db.prepare(`INSERT INTO tasks(owner,id,data,revision,deleted) SELECT ?,?,?,0,0 WHERE ${appliedGate}`).bind(owner,item.task.id,JSON.stringify(item.task),owner,batchId));
 const now=new Date().toISOString(),entryId=crypto.randomUUID();
 if(p.duplicates.length){
  statements.push(db.prepare(`INSERT INTO inbox_entries(owner,id,body,state,summary,plan_token,created_at,processed_at) SELECT ?,?,?,'processed',?,?,?,? WHERE ${appliedGate}`).bind(owner,entryId,'本地任务迁移：只导入任务，未上传本地原文、偏好或历史。',`新增 ${p.additions.length} 项，${p.duplicates.length} 项待确认。`,batchId,now,now,owner,batchId));
  for(const item of p.duplicates){const before=current.find(r=>r.id===item.targetId)!;const oldRow=await db.prepare('SELECT data FROM tasks WHERE owner=? AND id=?').bind(owner,item.targetId).first<{data:string}>();if(!oldRow)throw error('重复候选已变化。');const previous={...JSON.parse(oldRow.data),revision:before.revision} as Task;
   const after={...item.task,id:previous.id,revision:previous.revision};
   statements.push(db.prepare(`INSERT INTO task_changes(owner,id,entry_id,kind,before_data,after_data,reason,automatic,state,created_at) SELECT ?,?,?,'update',?,?,?,0,'pending',? WHERE ${appliedGate}`).bind(owner,crypto.randomUUID(),entryId,JSON.stringify(previous),JSON.stringify(after),item.reason!,now,owner,batchId));
  }
 }
 statements.push(db.prepare(`INSERT OR IGNORE INTO spaces(owner,initialized) SELECT ?,1 WHERE ${appliedGate}`).bind(owner,owner,batchId));
 statements.push(db.prepare("UPDATE task_imports SET state='applied',updated_at=? WHERE owner=? AND id=? AND state='applying'").bind(now,owner,batchId));
 const results=await db.batch(statements);if(!results[0].meta.changes){const check=await db.prepare('SELECT state FROM task_imports WHERE owner=? AND id=?').bind(owner,batchId).first<{state:string}>();if(check?.state==='applied')return {imported:p.additions.length,pending:p.duplicates.length,replayed:true};throw error('预览已过期，请重新生成。');}
 return {imported:p.additions.length,pending:p.duplicates.length,replayed:false};
}
