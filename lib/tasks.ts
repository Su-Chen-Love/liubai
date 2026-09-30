export type Task = { id:string; title:string; note:string; quadrant:number; category:string; due:string; deadline?:string; urgencyMode?:'auto'|'manualUrgent'|'manualNormal'; done:boolean; subtasks:{id:string;title:string;done:boolean}[]; revision:number };
export const QUADS = [
 {name:'现在行动',hint:'重要 · 紧急',tone:'coral',tip:'先让最牵挂的事，向前一步。'},
 {name:'从容计划',hint:'重要 · 不紧急',tone:'teal',tip:'为真正重要的事，留出时间。'},
 {name:'轻快处理',hint:'不重要 · 紧急',tone:'blue',tip:'集中处理，或请人帮个忙。'},
 {name:'留待以后',hint:'不重要 · 不紧急',tone:'gray',tip:'不必每件事，都在今天完成。'}
];
export const CATEGORIES=['工作','生活','成长'];
export function dayKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
export function plusDays(s:string,n:number){const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return dayKey(d);}
export function sampleTasks(today:string):Task[]{return [
 ['整理项目提案，准备明天的讨论','工作',0,0,'先把核心想法写清楚，再慢慢打磨。',['梳理关键问题','整理方案框架','检查演示材料']],
 ['预约这周的体检','生活',0,0,'给自己一点照顾。',[]],
 ['给个人作品集添一个新项目','成长',1,4,'不追求一下子完成，每次推进一点。',['挑选一个项目','写下设计过程','整理展示图片']],
 ['读完《慢一点也没关系》','成长',1,6,'每天读 20 分钟。',[]],
 ['安排一次周末散步','生活',1,5,'去一条没走过的小路。',[]],
 ['回复合作方的确认邮件','工作',2,0,'确认时间、参与人和材料。',[]],
 ['整理桌面和下载文件夹','生活',2,1,'只整理最近一个月的文件。',[]],
 ['收集下一次旅行的灵感','生活',3,12,'让期待慢慢积攒。',[]],
 ['试试手冲咖啡的新配方','生活',3,null,'留给一个悠闲的早晨。',[]]
 ].map((r,i)=>({id:`sample-${i}`,title:r[0] as string,category:r[1] as string,quadrant:r[2] as number,due:r[3]===null?'':plusDays(today,r[3] as number),note:r[4] as string,done:false,revision:0,subtasks:(r[5] as string[]).map((title,j)=>({id:`sub-${i}-${j}`,title,done:i===0&&j===0}))}));}
