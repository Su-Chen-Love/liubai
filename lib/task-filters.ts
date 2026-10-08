import type {Task} from './tasks';
import {taskDate} from './urgency';

export const TIME_RANGES=['全部时间','今天','明天','近 3 天','本周','以后','待重新安排','未排期'] as const;
export type TimeRange=typeof TIME_RANGES[number];

// Calendar arithmetic stays independent of the browser's timezone and DST.
export function calendarOffset(day:string,offset:number){
 const date=new Date(day+'T12:00:00Z');
 date.setUTCDate(date.getUTCDate()+offset);
 return date.toISOString().slice(0,10);
}

export function matchesTimeRange(task:Pick<Task,'due'|'deadline'|'done'>,range:TimeRange,today:string){
 const date=taskDate(task);
 const weekEnd=calendarOffset(today,7-(new Date(today+'T12:00:00Z').getUTCDay()||7));
 switch(range){
  case '全部时间':return true;
  case '未排期':return !date;
  case '待重新安排':return !task.done&&!!date&&date<today;
  case '今天':return date===today;
  case '明天':return date===calendarOffset(today,1);
  case '近 3 天':return !!date&&date>=today&&date<=calendarOffset(today,2);
  case '本周':return !!date&&date>=today&&date<=weekEnd;
  case '以后':return !!date&&date>weekEnd;
 }
}
