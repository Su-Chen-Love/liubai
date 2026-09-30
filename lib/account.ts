/** Browser partition identifier. Ownership always comes from the trusted Sites identity. */
export async function accountKey(userId:string){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('liubai-account-v1:'+userId));
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function assertAccount(request:Request,userId:string){
 if(request.headers.get('X-Liubai-Account')!==await accountKey(userId))throw Object.assign(new Error('账号已切换，请重新连接后保存。'),{status:409,code:'ACCOUNT_CHANGED'});
}
