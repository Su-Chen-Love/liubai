/** Tracks browser identity checks independently of UI rendering and network cancellation. */
export type AccountTicket={epoch:number;accountKey:string|null};
export class AccountBoundary {
 epoch=0;
 private key:string|null=null;
 private verifying=true;
 snapshot():AccountTicket{return {epoch:this.epoch,accountKey:this.key}}
 beginVerification(){this.epoch++;this.verifying=true;return this.epoch}
 deferVerification(){this.verifying=true}
 adopt(accountKey:string){if(this.key!==accountKey)this.epoch++;this.key=accountKey;this.verifying=false}
 clear(){this.epoch++;this.key=null;this.verifying=true}
 accepts(ticket:AccountTicket,returnedAccountKey:unknown){return !this.verifying&&ticket.epoch===this.epoch&&ticket.accountKey!==null&&ticket.accountKey===this.key&&returnedAccountKey===this.key}
}
export function responseBelongsTo(value:unknown,accountKey:string){
 if(!value||typeof value!=='object')return false;
 const result=value as {accountKey?:unknown;account?:{key?:unknown}};
 return (result.accountKey??result.account?.key)===accountKey;
}
export const accountDraftKey=(accountKey:string)=>`liubai-editor-draft:${accountKey}`;
export function readAccountDraft<T extends {ownerKey:string}>(raw:string|null,accountKey:string,valid:(value:unknown)=>value is T):T|null {
 if(!raw)return null;
 try{const value=JSON.parse(raw);return valid(value)&&value.ownerKey===accountKey?value:null}catch{return null}
}
