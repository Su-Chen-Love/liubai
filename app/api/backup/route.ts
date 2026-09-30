import {getChatGPTUser} from '@/app/chatgpt-auth';
import {createSnapshot} from '@/lib/snapshot';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'no-store'};
 try{const u=await getChatGPTUser();if(!u)return Response.json({error:'请先登录。',code:'AUTH_REQUIRED'},{status:401,headers});return Response.json(await createSnapshot(u.userId),{headers})}
 catch{console.error('snapshot storage unavailable');return Response.json({error:'完整备份暂时无法读取。',code:'STORAGE_UNAVAILABLE'},{status:503,headers})}
}
