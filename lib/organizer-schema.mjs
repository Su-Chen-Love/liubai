import {z} from 'zod';
import {taskSchema} from './task-schema.mjs';
export const changeSchema=z.object({id:z.string().uuid(),kind:z.enum(['create','update','delete']),task:taskSchema,reason:z.string().trim().min(1).max(1200),automatic:z.boolean().default(false)}).strict();
export const planSchema=z.object({action:z.literal('plan'),entryId:z.string().uuid(),summary:z.string().trim().min(1).max(2000),changes:z.array(changeSchema).max(40)}).strict();

export const normalizedTitle=s=>s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');

export function validatePlanInvariants(plan){
 if(new Set(plan.changes.map(c=>c.id)).size!==plan.changes.length||new Set(plan.changes.map(c=>c.task.id)).size!==plan.changes.length)throw Error('同一批次不能重复修改一项任务。');
 const titles=plan.changes.filter(c=>c.kind==='create').map(c=>normalizedTitle(c.task.title));
 if(new Set(titles).size!==titles.length)throw Error('这份计划含重名新任务，请合并后重试。');
 for(const change of plan.changes){
  if(change.kind==='create'&&change.task.revision!==0)throw Error('新任务版本号必须为0。');
  if(change.kind!=='delete'&&change.task.done&&change.task.subtasks.some(step=>!step.done))throw Error('已完成任务不能包含未完成步骤。');
 }
}
