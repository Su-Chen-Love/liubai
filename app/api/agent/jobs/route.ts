import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {validMachineToken,agentQueue,agentAction} from '@/lib/agent-service';
import {OrganizerConflict} from '@/lib/organizer-service';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
function machineHash(){return (env as Cloudflare.Env&{LIUBAI_AGENT_TOKEN_HASH?:string}).LIUBAI_AGENT_TOKEN_HASH}
async function authorized(request:Request){return validMachineToken(request.headers.get('authorization'),machineHash())}
export async function GET(request:Request){
 try{if(!await authorized(request))return reply({error:'机器身份校验失败。',code:'AGENT_AUTH_REQUIRED'},401);return reply(await agentQueue())}
 catch{console.error('agent queue storage unavailable');return reply({error:'队列暂时无法读取。',code:'STORAGE_UNAVAILABLE'},503)}
}
export async function POST(request:Request){
 try{
  if(!await authorized(request))return reply({error:'机器身份校验失败。',code:'AGENT_AUTH_REQUIRED'},401);
  const text=await request.text();if(text.length>300000)return reply({error:'内容过长。',code:'INVALID_INPUT'},413);
  const body=z.record(z.unknown()).parse(JSON.parse(text));
  return reply(await agentAction(body,machineHash()!));
 }catch(e){
  if(e instanceof z.ZodError||e instanceof SyntaxError)return reply({error:'内容格式不正确。',code:'INVALID_INPUT'},400);
  if(e instanceof OrganizerConflict)return reply({error:e.message,code:e.code},409);
  console.error('agent operation storage unavailable');return reply({error:'写入未确认，请保留计划后重试。',code:'STORAGE_UNAVAILABLE'},503);
 }
}
