#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decryptSnapshot,digest,localSnapshot,readPrivateJSON,saveSnapshot,snapshotTables,writePrivateJSON} from './backups.mjs';

export function buildImportRequest(local,cloud,accountKey,{batchId=randomUUID(),now=new Date()}={}){
 if(typeof accountKey!=='string'||!accountKey||cloud.accountKey!==accountKey)throw Error('云端快照与目标账号不匹配');
 snapshotTables(local);snapshotTables(cloud);
 if(typeof local.accountKey!=='string'||!local.accountKey)throw Error('本地快照缺少账号绑定');
 const sourceId=`local-${digest({accountKey:local.accountKey})}`;
 const tasks=local.tables.tasks.filter(row=>row.deleted===0).map(row=>{
  let task;try{task=JSON.parse(row.data);}catch{throw Error('本地任务格式无效');}
  if(!task||typeof task!=='object'||Array.isArray(task)||typeof row.id!=='string'||!Number.isInteger(row.revision))throw Error('本地任务标识或版本无效');
  return {...task,id:row.id,revision:row.revision};
 });
 if(new Set(tasks.map(task=>task.id)).size!==tasks.length)throw Error('本地快照任务标识重复');
 return {format:'liubai-import-request',version:1,accountKey,batchId,sourceId,sourceChecksum:digest(local),cloudSnapshotChecksum:digest(cloud),cloudBusinessHash:cloud.businessHash,createdAt:now.toISOString(),tasks};
}
async function main(){
 const [command='help',accountKey,cloudFile]=process.argv.slice(2);
 if(command==='help'){console.log('任务合并准备：node scripts/import-tasks.mjs preview <accountKey> <加密云端快照文件>\n仅生成当前本地未删除任务的导入文件（包含已完成）。在浏览器登录目标账号后预览并确认；此脚本不调用云端写接口，也不上传收件箱、偏好或历史。');return;}
 if(command!=='preview'||!accountKey||!cloudFile)throw Error('需要preview、目标accountKey和加密云端快照文件');
 const root=fileURLToPath(new URL('..',import.meta.url));
 const config=await readPrivateJSON(path.join(root,'.liubai/remote.json'));
 const cloud=decryptSnapshot(await readPrivateJSON(path.resolve(cloudFile)),config.backupKey);
 const local=await localSnapshot();
 const backup=await saveSnapshot(local,{directory:path.join(root,'.liubai/backups'),key:config.backupKey,source:'http://127.0.0.1:4178'});
 const request=buildImportRequest(local,cloud,accountKey);
 const file=path.join(root,'.liubai/imports',`${request.batchId}.json`);
 await writePrivateJSON(file,request,{exclusive:true});
 console.log(JSON.stringify({ok:true,file,accountKey,sourceId:request.sourceId,batchId:request.batchId,tasks:request.tasks.length,completed:request.tasks.filter(task=>task.done).length,localBackupVerified:true,newLocalBackup:backup.changed,cloudWritten:false},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
