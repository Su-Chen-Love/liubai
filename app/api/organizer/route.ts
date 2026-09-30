import {z} from 'zod';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {database} from '@/lib/database';
import {profileSchema} from '@/lib/organizer';
import {accountKey,assertAccount} from '@/lib/account';
import {OrganizerConflict,ensureProfile,organizerState,updateGrant,applyChange,resumeAutomatic,savePlan,organizerCheckin} from '@/lib/organizer-service';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(){
 try{const u=await getChatGPTUser();if(!u)return reply({error:'请先登录。',code:'AUTH_REQUIRED'},401);return reply({...await organizerState(u.userId,u.local),accountKey:await accountKey(u.userId)})}
 catch{console.error('organizer read unavailable');return reply({error:'收件箱暂时无法连接，请稍后重试。',code:'STORAGE_UNAVAILABLE'},503)}
}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&new URL(origin).host!==new URL(request.url).host)return reply({error:'请求来源不匹配。'},403);
 const u=await getChatGPTUser();if(!u)return reply({error:'请先登录。',code:'AUTH_REQUIRED'},401);
 await assertAccount(request,u.userId);
 const owner=u.userId,db=database(),text=await request.text();if(text.length>300000)return reply({error:'内容过长。'},413);
 const body=z.record(z.unknown()).parse(JSON.parse(text));
 if(body.action==='submit'){
  const id=z.string().uuid().parse(body.id),content=z.string().trim().min(1).max(20000).parse(body.text);
  await db.prepare('INSERT OR IGNORE INTO inbox_entries (owner,id,body,created_at) VALUES (?,?,?,?)').bind(owner,id,content,new Date().toISOString()).run();
  const saved=await db.prepare('SELECT body FROM inbox_entries WHERE owner=? AND id=?').bind(owner,id).first<{body:string}>();
  if(saved?.body!==content)throw new OrganizerConflict('这份输入已保存，请刷新后查看，或提交为新的一份。');return reply({id});
 }
 if(body.action==='grant'){
  const enabled=z.boolean().parse(body.enabled),remoteGrant=await updateGrant(owner,await accountKey(owner),enabled);
  return reply({remoteGrant,profile:(await organizerState(owner,u.local)).profile});
 }
 if(body.action==='profile'){
  await ensureProfile(owner);const profile=profileSchema.parse(body.profile),revision=z.number().int().min(0).parse(body.revision);
  // remoteEnabled comes exclusively from an explicit, revocable user grant.
  const saved={...profile,remoteEnabled:false};
  const r=await db.prepare('UPDATE organizer_profiles SET data=?,revision=revision+1 WHERE owner=? AND revision=?').bind(JSON.stringify(saved),owner,revision).run();
  if(!r.meta.changes)throw new OrganizerConflict('整理偏好已变化，请重新载入后修改。');return reply({profile:(await organizerState(owner,u.local)).profile,revision:revision+1});
 }
 if(body.action==='decide'){
  const id=z.string().uuid().parse(body.id),decision=z.enum(['accept','dismiss']).parse(body.decision);
  if(decision==='accept')await applyChange(owner,id);else await db.prepare("UPDATE task_changes SET state='dismissed',decided_at=? WHERE owner=? AND id=? AND state='pending'").bind(new Date().toISOString(),owner,id).run();
  return reply(await organizerState(owner,u.local));
 }
 // Browser identity alone never grants a cloud worker the machine channel.
 if(!u.local)return reply({error:'云端自动整理使用独立授权的机器通道。',code:'MACHINE_CHANNEL_REQUIRED'},403);
 if(body.action==='checkin')return reply(await organizerCheckin(owner,z.string().max(500).parse(body.result)));
 if(body.action==='resume')return reply(await resumeAutomatic(owner));
 if(body.action==='plan'){const receipt=await savePlan(owner,body);return reply({...await organizerState(owner,true),...receipt})}
 return reply({error:'未知操作。'},400);
}catch(e){
 if(e instanceof z.ZodError||e instanceof SyntaxError)return reply({error:'内容格式不正确，请检查输入。',code:'INVALID_INPUT'},400);
 if(e instanceof OrganizerConflict)return reply({error:e.message,code:e.code},409);
 if(e instanceof Error&&'code' in e&&e.code==='ACCOUNT_CHANGED')return reply({error:e.message,code:'ACCOUNT_CHANGED'},409);
 console.error('organizer write unavailable');return reply({error:'写入未确认，请保留内容后重试。',code:'STORAGE_UNAVAILABLE'},503);
}}
