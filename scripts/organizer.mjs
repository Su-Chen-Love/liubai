#!/usr/bin/env node
if(process.argv[2]==='remote'){
 try{const {remoteMain}=await import('./remote-organizer.mjs');await remoteMain(process.argv.slice(3));}catch(e){console.error(e.message);process.exitCode=1;}
}else{
const [command='help',arg]=process.argv.slice(2);
const base='http://127.0.0.1:4178';
let accountKey;
async function api(route,body){if(body&&!accountKey)throw Error('本地账号握手未完成');const r=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',Origin:base,'X-Liubai-Account':accountKey}:undefined,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.headers.get('content-type')?.includes('json'))throw Error('请确认运行的是本地留白');const d=await r.json();if(!r.ok)throw Error(d.error||'接口失败');return d;}
async function input(){let s='';for await(const part of process.stdin){s+=part;if(s.length>300000)throw Error('输入过长')}return s;}
try{
 if(command==='help'){console.log('留白整理入口：status | queue | submit < 原文.txt | plan < 计划.json | resume | checkin "结果摘要" | profile < 偏好.json\n以上命令仅操作本地空间。远程模式：node scripts/organizer.mjs remote help。计划协议与准则见 ORGANIZER.md。');process.exit(0)}
 const tasks=await api('/api/tasks');if(tasks.account?.mode!=='local')throw Error('整理入口仅允许本地空间');const call=body=>api('/api/organizer',body);let result;
 accountKey=tasks.account?.key;
 if(command==='status')result=await call();
 else if(command==='queue'){const d=await call();result={now:new Date().toISOString(),timezone:d.profile.timezone,profile:d.profile,entries:d.entries.filter(e=>e.state==='pending').sort((a,b)=>a.created_at.localeCompare(b.created_at)),pendingChanges:d.changes.filter(c=>c.state==='pending'),tasks:tasks.tasks};}
 else if(command==='submit')result=await call({action:'submit',id:arg||crypto.randomUUID(),text:await input()});
 else if(command==='plan')result=await call({action:'plan',...JSON.parse(await input())});
 else if(command==='resume')result=await call({action:'resume'});
 else if(command==='checkin')result=await call({action:'checkin',result:arg||'检查完成'});
 else if(command==='profile'){const d=await call();result=await call({action:'profile',revision:d.profileRevision,profile:JSON.parse(await input())});}
 else throw Error('未知命令，请运行 help');
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.cause?.code==='ECONNREFUSED'?'本地留白未运行，请先运行 npm run local。':e.message);process.exitCode=1;}
}
