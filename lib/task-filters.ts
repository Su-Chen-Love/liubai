import type {Task} from './tasks';

export const TIME_RANGES=['全部时间','今天','明天','近 3 天','本周','以后','待重新安排','未排期'] as const;
export type TimeRange=typeof TIME_RANGES[number];

// Calendar arithmetic stays independent of the browser's timezone and DST.
export function calendarOffset(day:string,offset:number){
 const date=new Date(day+'T12:00:00Z');
 date.setUTCDate(date.getUTCDate()+offset);
 return date.toISOString().slice(0,10);
}

export function matchesTimeRange(task:Pick<Task,'due'|'deadline'|'done'>,range:TimeRange,today:string){
 const dates=[task.due,task.deadline||''].filter(Boolean);
 const weekEnd=calendarOffset(today,7-(new Date(today+'T12:00:00Z').getUTCDay()||7));
 switch(range){
  case '全部时间':return true;
  case '未排期':return dates.length===0;
  case '待重新安排':return !task.done&&dates.some(date=>date<today);
  case '今天':return dates.includes(today);
  case '明天':return dates.includes(calendarOffset(today,1));
  case '近 3 天':return dates.some(date=>date>=today&&date<=calendarOffset(today,2));
  case '本周':return dates.some(date=>date>=today&&date<=weekEnd);
  case '以后':return dates.some(date=>date>weekEnd);
 }
}
