import {z} from 'zod';
import {taskSchema} from './task-schema';
import type {Task} from './tasks';
export const defaultProfile={about:'',preferences:'界面与任务标题保持中文、清晰、简洁。不同截止日期的成果拆开，同一成果的执行步骤合并为子任务。保留原文中的不确定性，不猜测完成状态。',autoSafe:true};
export const profileSchema=z.object({about:z.string().max(2000),preferences:z.string().max(4000),autoSafe:z.boolean()}).strict();
export type Profile=z.infer<typeof profileSchema>;
export const changeSchema=z.object({id:z.string().uuid(),kind:z.enum(['create','update','delete']),task:taskSchema,reason:z.string().trim().min(1).max(1200),automatic:z.boolean().default(false)}).strict();
export const planSchema=z.object({action:z.literal('plan'),entryId:z.string().uuid(),summary:z.string().trim().min(1).max(2000),changes:z.array(changeSchema).max(40)}).strict();
export type Change={id:string;entry_id:string;kind:'create'|'update'|'delete';before:Task|null;after:Task;reason:string;automatic:number;state:'pending'|'applied'|'dismissed'|'superseded';created_at:string;decided_at:string|null};
export type Entry={id:string;body:string;state:string;summary:string;created_at:string;processed_at:string|null};
export type OrganizerState={entries:Entry[];changes:Change[];profile:Profile;profileRevision:number;lastCheck:string|null;lastResult:string;local:boolean};
export function safeAppend(before:Task,after:Task){
 if(before.title!==after.title||before.quadrant!==after.quadrant||before.category!==after.category||before.due!==after.due||before.done!==after.done)return false;
 if(!after.note.startsWith(before.note))return false;
 return new Set(after.subtasks.map(s=>s.id)).size===after.subtasks.length&&before.subtasks.every((s,i)=>{const n=after.subtasks[i];return n&&n.id===s.id&&n.title===s.title&&n.done===s.done})&&after.subtasks.slice(before.subtasks.length).every(s=>!s.done);
}
export const normalizedTitle=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
