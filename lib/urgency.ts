import type {Task} from './tasks';
export type UrgencyPreferences={urgentDays:number;timezone:string};
export const defaultUrgency:UrgencyPreferences={urgentDays:3,timezone:'Asia/Shanghai'};
export function dateInTimezone(now=new Date(),timezone='Asia/Shanghai'):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const part=(type:string)=>parts.find(p=>p.type===type)?.value??'';
 return `${part('year')}-${part('month')}-${part('day')}`;
}
function ordinal(date:string){return Math.floor(Date.parse(date+'T00:00:00Z')/86400000)}
export function urgencyInfo(task:Task,prefs:UrgencyPreferences=defaultUrgency,now=new Date()) {
 const date=taskDate(task),today=dateInTimezone(now,prefs.timezone),remaining=date?ordinal(date)-ordinal(today):null;
 const manual=task.urgencyMode==='manualUrgent'?true:task.urgencyMode==='manualNormal'?false:task.quadrant%2===0;
 const automatic=task.urgencyMode==='auto'&&!task.done&&remaining!==null;
 const urgent=task.done?manual:automatic?remaining!==null&&remaining<=prefs.urgentDays:manual;
 return {urgent,automatic,remaining,overdue:!task.done&&remaining!==null&&remaining<0,quadrant:(task.quadrant<2?0:2)+(urgent?0:1)};
}
export function effectiveQuadrant(task:Task,prefs:UrgencyPreferences=defaultUrgency,now=new Date()){return urgencyInfo(task,prefs,now).quadrant}
// due is the single planned date. Read the historical alias without rewriting history.
export function taskDate(task:Pick<Task,'due'|'deadline'>){return task.due||task.deadline||''}
export function withTaskDate(task:Task,date:string):Task{return {...task,due:date,...('deadline' in task?{deadline:date}:{})}}
export function placeInQuadrant(task:Task,target:number,prefs:UrgencyPreferences=defaultUrgency,now=new Date()):Task{
 const current=effectiveQuadrant(task,prefs,now);
 if(target===current)return task;
 const changedUrgency=target%2!==current%2;
 return {...task,quadrant:(target<2?0:2)+(changedUrgency?target%2:task.quadrant%2),...(changedUrgency?{urgencyMode:target%2===0?'manualUrgent' as const:'manualNormal' as const}:{})};
}
