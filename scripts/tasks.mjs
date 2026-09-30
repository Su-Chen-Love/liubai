#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const [command='help',id,...rest]=process.argv.slice(2);
const url='http://127.0.0.1:4178/api/tasks';
async function api(body){const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',Origin:'http://127.0.0.1:4178'}:undefined,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');return data;}
async function stdin(){let raw='';for await(const chunk of process.stdin)raw+=chunk;if(raw.length>30000)throw Error('输入过长');return JSON.parse(raw);}
function day(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
try{
if(command==='help'){console.log('留白 Agent 入口（先运行 npm run local）\nlist | agenda [YYYY-MM-DD] | create < task.json | update ID < changes.json | complete ID | reopen ID | delete ID | export [file.json]\ncreate/update 从标准输入读取 JSON；象限 0=现在行动 1=从容计划 2=轻快处理 3=留待以后。');process.exit(0);}
const data=await api();if(data.account?.mode!=='local')throw Error('CLI 只允许操作留白本地空间。');let output;
if(command==='list')output=data.tasks;
else if(command==='agenda'){const today=id||day();if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(Date.parse(today))||new Date(today).toISOString().slice(0,10)!==today)throw Error('日期格式无效');const tasks=data.tasks.filter(t=>!t.done);output={date:today,overdue:tasks.filter(t=>t.due&&t.due<today),today:tasks.filter(t=>t.due===today),important:tasks.filter(t=>t.quadrant<2),unscheduled:tasks.filter(t=>!t.due)};}
else if(command==='export'){const backup={format:'liubai-tasks',version:1,exportedAt:new Date().toISOString(),tasks:data.tasks};if(id){writeFileSync(id,JSON.stringify(backup,null,2)+'\n',{flag:'wx',mode:0o600});output={exported:id,count:data.tasks.length};}else output=backup;}
else if(command==='create'){const input=await stdin();if(!input||typeof input!=='object'||Array.isArray(input))throw Error('需要任务JSON对象');output=await api({action:'create',task:{note:'',quadrant:1,category:'工作',due:'',done:false,subtasks:[],...input,id:randomUUID(),revision:0}});}
else{const task=data.tasks.find(t=>t.id===id);if(!task)throw Error('找不到任务，请先 list 获取准确ID');if(command==='delete')output=await api({action:'delete',id,revision:task.revision});else if(command==='complete'||command==='reopen')output=await api({action:'update',task:{...task,done:command==='complete'}});else if(command==='update'){const changes=await stdin();if(!changes||typeof changes!=='object'||Array.isArray(changes))throw Error('需要修改JSON对象');if(changes.id||changes.revision!==undefined)throw Error('不可修改ID或revision');output=await api({action:'update',task:{...task,...changes}});}else throw Error('未知命令，请运行 help');}
console.log(JSON.stringify(output,null,2));
}catch(e){console.error(e.cause?.code==='ECONNREFUSED'?'本地留白尚未启动，请先运行 npm run local。':e.message);process.exitCode=1;}
