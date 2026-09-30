import {getChatGPTUser} from '@/app/chatgpt-auth';
import {assertAccount,accountKey} from '@/lib/account';
import {previewImport,applyImport} from '@/lib/import-service';
import {z} from 'zod';
export const dynamic='force-dynamic';
const respond=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&new URL(origin).host!==new URL(request.url).host)return respond({error:'请求来源不匹配。'},403);
 const user=await getChatGPTUser();if(!user)return respond({error:'请先登录。'},401);await assertAccount(request,user.userId);
 const body=z.record(z.unknown()).parse(await request.json());if(body.accountKey&&body.accountKey!==await accountKey(user.userId))return respond({error:'导入文件绑定了另一账号。'},409);if(body.action==='preview')return respond({preview:await previewImport(user.userId,{batchId:body.batchId,sourceId:body.sourceId,tasks:body.tasks})});
 if(body.action==='apply')return respond(await applyImport(user.userId,z.string().uuid().parse(body.batchId)));
 return respond({error:'未知导入操作。'},400);
}catch(e){if(e instanceof z.ZodError||e instanceof SyntaxError)return respond({error:'导入文件格式不正确。'},400);if(e instanceof Error&&'status' in e)return respond({error:e.message},Number(e.status));return respond({error:'导入未确认，请保留文件并重试。'},503);}}
