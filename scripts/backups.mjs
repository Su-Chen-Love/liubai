#!/usr/bin/env node
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdir,lstat,readFile,open,rename,link,readdir,unlink,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export const canonical=value=>JSON.stringify(normalize(value));
function normalize(value){if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])]));return value;}
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
export function backupKey(value){if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw Error('备份密钥格式无效');const key=Buffer.from(value,'base64');if(key.length!==32)throw Error('备份密钥必须为32字节');return key;}
export async function privateDir(directory){await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('安全目录无效');if(process.getuid&&stat.uid!==process.getuid())throw Error('目录所有者不匹配');await chmod(directory,0o700);}
export async function readPrivateJSON(file){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error('配置或任务文件必须属于当前用户且权限为600');if(stat.size>32*1024*1024)throw Error('文件超过大小限制');const content=await readFile(file,'utf8');try{return JSON.parse(content);}catch{throw Error('受保护JSON文件格式无效，内容未输出');}}
export async function writePrivateJSON(file,value,{exclusive=false}={}){await privateDir(path.dirname(file));const temp=path.join(path.dirname(file),`.tmp-${randomUUID()}`);try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(`${JSON.stringify(value)}\n`);await handle.sync();}finally{await handle.close();}if(exclusive)await link(temp,file);else await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}

// These are application data columns, never SQL supplied by a snapshot.
const TABLES={
 tasks:{owner:'TEXT NOT NULL',id:'TEXT NOT NULL',data:'TEXT NOT NULL',revision:'INTEGER NOT NULL',deleted:'INTEGER NOT NULL'},
 spaces:{owner:'TEXT NOT NULL',initialized:'INTEGER NOT NULL'},
 inbox_entries:{owner:'TEXT NOT NULL',id:'TEXT NOT NULL',body:'TEXT NOT NULL',state:'TEXT NOT NULL',summary:'TEXT NOT NULL',plan_token:'TEXT',created_at:'TEXT NOT NULL',processed_at:'TEXT'},
 task_changes:{owner:'TEXT NOT NULL',id:'TEXT NOT NULL',entry_id:'TEXT NOT NULL',kind:'TEXT NOT NULL',before_data:'TEXT',after_data:'TEXT NOT NULL',reason:'TEXT NOT NULL',automatic:'INTEGER NOT NULL',state:'TEXT NOT NULL',created_at:'TEXT NOT NULL',decided_at:'TEXT'},
 organizer_profiles:{owner:'TEXT NOT NULL',data:'TEXT NOT NULL',revision:'INTEGER NOT NULL',last_check:'TEXT',last_result:'TEXT NOT NULL'},
 task_imports:{owner:'TEXT NOT NULL',id:'TEXT NOT NULL',data:'TEXT NOT NULL',state:'TEXT NOT NULL',created_at:'TEXT NOT NULL',updated_at:'TEXT NOT NULL'},
};
export function snapshotTables(snapshot){if(!snapshot||snapshot.format!=='liubai-snapshot'||snapshot.version!==1||typeof snapshot.accountKey!=='string'||!snapshot.tables||Array.isArray(snapshot.tables)||!snapshot.counts)throw Error('不是受支持的完整快照');const allowed=new Set([...Object.keys(TABLES),'organizer_grants','agent_jobs']);for(const [name,rows]of Object.entries(snapshot.tables)){if(!allowed.has(name)||!Array.isArray(rows))throw Error('快照含未知表或表格式无效');if(rows.length>100000)throw Error('快照行数超过限制');if(snapshot.counts[name]!==rows.length)throw Error('快照行数不匹配');for(const row of rows){if(!row||typeof row.owner!=='string'||digest(`liubai-account-v1:${row.owner}`)!==snapshot.accountKey)throw Error('快照包含不属于此账号的数据');}}for(const name of Object.keys(TABLES))if(!Array.isArray(snapshot.tables[name]))throw Error('快照缺少完整业务表');if(snapshot.hashAlgorithm){if(snapshot.hashAlgorithm!=='sha256-canonical-json-v1'||snapshot.snapshotHash!==digest(snapshot.tables))throw Error('服务器快照校验和不匹配');const business=Object.fromEntries(Object.keys(TABLES).map(name=>[name,name==='organizer_profiles'?snapshot.tables[name].map(({last_check,last_result,...row})=>row):snapshot.tables[name]]));if(snapshot.businessHash!==digest(business))throw Error('服务器业务水位不匹配');}return snapshot.tables;}
export function encryptSnapshot(snapshot,keyText){snapshotTables(snapshot);const text=canonical(snapshot);const header={format:'liubai-encrypted-snapshot',version:1,cipher:'AES-256-GCM',accountKey:snapshot.accountKey,createdAt:new Date().toISOString(),checksum:digest(text)};if(typeof header.accountKey!=='string'||!header.accountKey)throw Error('快照缺少账号绑定');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',backupKey(keyText),iv);cipher.setAAD(Buffer.from(canonical(header)));const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return {...header,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};}
export function decryptSnapshot(envelope,keyText){const {iv,tag,ciphertext,...header}=envelope;if(header.format!=='liubai-encrypted-snapshot'||header.version!==1||header.cipher!=='AES-256-GCM')throw Error('不支持的备份格式');if(typeof ciphertext!=='string'||ciphertext.length>44*1024*1024)throw Error('备份大小无效');const ivBytes=Buffer.from(iv||'','base64'),tagBytes=Buffer.from(tag||'','base64');if(ivBytes.length!==12||tagBytes.length!==16)throw Error('备份加密参数无效');try{const decipher=createDecipheriv('aes-256-gcm',backupKey(keyText),ivBytes);decipher.setAAD(Buffer.from(canonical(header)));decipher.setAuthTag(tagBytes);const plain=Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]).toString('utf8');if(digest(plain)!==header.checksum)throw Error();const snapshot=JSON.parse(plain);if(snapshot.accountKey!==header.accountKey)throw Error();snapshotTables(snapshot);return snapshot;}catch{throw Error('备份完整性验证失败，未恢复任何数据');}}
function ownRegular(stat){return stat.isFile()&&!stat.isSymbolicLink()&&(!process.getuid||stat.uid===process.getuid());}
async function pruneFolder(folder,now){
 const cutoff=now.getTime()-30*86400000;let removedFiles=0,removedWatermarks=0;
 for(const name of await readdir(folder)){
  // Only generated encrypted snapshots and their obsolete watermark are eligible.
  // No file is opened, decrypted, or followed through a symlink.
  if(!name.endsWith('.json.enc')&&name!=='watermark.json')continue;
  const file=path.join(folder,name);let stat;try{stat=await lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!ownRegular(stat)||stat.mtimeMs>=cutoff)continue;
  try{await unlink(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(name==='watermark.json')removedWatermarks++;else removedFiles++;
 }
 return {removedFiles,removedWatermarks};
}
export async function pruneBackups(directory,{now=new Date()}={}){
 if(!Number.isFinite(now.getTime()))throw Error('备份清理时间无效');
 let base;try{base=await lstat(directory);}catch(e){if(e.code==='ENOENT')return {removedFiles:0,removedWatermarks:0,checkedDirectories:0};throw e;}
 if(!base.isDirectory()||base.isSymbolicLink()||(process.getuid&&base.uid!==process.getuid()))throw Error('备份目录不安全，未执行清理');
 const result={removedFiles:0,removedWatermarks:0,checkedDirectories:0};
 for(const name of await readdir(directory)){
  if(!/^[a-f0-9]{64}$/.test(name))continue;
  const folder=path.join(directory,name),stat=await lstat(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))continue;
  const removed=await pruneFolder(folder,now);result.checkedDirectories++;result.removedFiles+=removed.removedFiles;result.removedWatermarks+=removed.removedWatermarks;
 }
 return result;
}
export async function saveSnapshot(snapshot,{directory,key,source,now=new Date()}){snapshotTables(snapshot);const businessHash=snapshot.businessHash;if(typeof businessHash!=='string'||!businessHash)throw Error('快照缺少业务水位');await privateDir(directory);const identity=digest({source,accountKey:snapshot.accountKey});const folder=path.join(directory,identity);await privateDir(folder);await pruneFolder(folder,now);const markFile=path.join(folder,'watermark.json');let mark;try{mark=await readPrivateJSON(markFile);}catch(e){if(e.code!=='ENOENT')throw e;}if(mark?.businessHash===businessHash&&mark.file){try{const prior=decryptSnapshot(await readPrivateJSON(path.join(folder,path.basename(mark.file))),key);if(prior.businessHash===businessHash&&prior.accountKey===snapshot.accountKey)return {changed:false,accountKey:snapshot.accountKey};}catch(e){if(e.code!=='ENOENT')throw e;}}
 const envelope=encryptSnapshot(snapshot,key),name=`${now.toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.json.enc`,file=path.join(folder,name);await writePrivateJSON(file,envelope);const checked=decryptSnapshot(await readPrivateJSON(file),key);if(digest(checked)!==digest(snapshot))throw Error('备份落盘校验失败');await writePrivateJSON(markFile,{version:1,businessHash,file:name,checksum:envelope.checksum,savedAt:now.toISOString()});
 await pruneFolder(folder,now);
 return {changed:true,accountKey:snapshot.accountKey,file,checksum:envelope.checksum};
}
export async function rehearseRestore(snapshot){const tables=snapshotTables(snapshot);const {DatabaseSync}=await import('node:sqlite');const directory=await mkdtemp(path.join(os.tmpdir(),'liubai-restore-'));await chmod(directory,0o700);const file=path.join(directory,'rehearsal.sqlite'),db=new DatabaseSync(file);await chmod(file,0o600);const counts={};try{db.exec('BEGIN');for(const [name,columns]of Object.entries(TABLES)){const keys=Object.keys(columns),primary=['spaces','organizer_profiles'].includes(name)?['owner']:['owner','id'];db.exec(`CREATE TABLE "${name}" (${keys.map(k=>`"${k}" ${columns[k]}`).join(',')}, PRIMARY KEY (${primary.map(k=>`"${k}"`).join(',')}))`);const statement=db.prepare(`INSERT INTO "${name}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);for(const row of tables[name]){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!keys.includes(k)))throw Error('快照含未知业务列');const values=keys.map(k=>row[k]??null);if(values.some(v=>v!==null&&!['string','number'].includes(typeof v)))throw Error('快照数据类型无效');statement.run(...values);}counts[name]=Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n);if(counts[name]!==tables[name].length)throw Error('恢复计数不符');const readback=db.prepare(`SELECT * FROM "${name}"`).all();if(digest(readback)!==digest(tables[name]))throw Error('恢复内容校验不符');}db.exec('COMMIT');if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite完整性检查失败');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}return {ok:true,file,counts,excludedTables:Object.keys(tables).filter(name=>!TABLES[name]),runtimeAuthorizationRestored:false,leasesRestored:false};}

export async function localSnapshot(fetchImpl=fetch){const base='http://127.0.0.1:4178';async function get(route){const response=await fetchImpl(base+route,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('本地完整快照API不可用');return response.json();}const tasks=await get('/api/tasks');if(tasks.account?.mode!=='local')throw Error('本地快照只允许回环本地账号');const result=await get('/api/backup'),snapshot=result.snapshot||result;snapshotTables(snapshot);if(!tasks.account?.key||snapshot.accountKey!==tasks.account.key)throw Error('本地快照账号与握手不匹配');return snapshot;}
async function main(){const [command,file]=process.argv.slice(2);if(!['verify','rehearse','local'].includes(command)){console.log('加密备份：node scripts/backups.mjs local | verify|rehearse <备份文件>；密钥读取本项目 .liubai/remote.json。rehearse只新建临时空SQLite，绝不写运行数据库。');return;}const root=fileURLToPath(new URL('..',import.meta.url)),config=await readPrivateJSON(path.join(root,'.liubai/remote.json'));if(command==='local'){console.log(JSON.stringify(await saveSnapshot(await localSnapshot(),{directory:path.join(root,'.liubai/backups'),key:config.backupKey,source:'http://127.0.0.1:4178'})));return;}if(!file)throw Error('需要备份文件路径');const snapshot=decryptSnapshot(await readPrivateJSON(path.resolve(file)),config.backupKey);console.log(JSON.stringify(command==='verify'?{ok:true,accountKey:snapshot.accountKey,counts:Object.fromEntries(Object.entries(snapshotTables(snapshot)).map(([k,v])=>[k,v.length]))}:await rehearseRestore(snapshot)));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('备份验证或恢复演练失败；未写入运行数据库。');process.exitCode=1;});
