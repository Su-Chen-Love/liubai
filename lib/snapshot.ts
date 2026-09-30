import {database} from './database';
import {accountKey} from './account';
import {leaseCondition,OrganizerConflict} from './organizer-service';
import type {LeaseGuard} from './organizer-service';

export const SNAPSHOT_TABLES=['tasks','spaces','inbox_entries','task_changes','organizer_profiles','organizer_grants','agent_jobs','task_imports'] as const;
export function canonicalJSON(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON((value as Record<string,unknown>)[k])).join(',')+'}';
}
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function createSnapshot(owner:string,lease?:LeaseGuard){
 const db=database(),gate=leaseCondition(lease,true);
 // D1 batch provides one transaction/snapshot for all tables. Tombstones,
 // processed inputs and all proposals are included; there are no list limits.
 const results=await db.batch([
  db.prepare(`SELECT ${gate.sql} AS allowed`).bind(...gate.values),
  ...SNAPSHOT_TABLES.map(name=>db.prepare(`SELECT * FROM ${name} WHERE owner=? AND ${gate.sql} ORDER BY owner${name==='spaces'||name==='organizer_profiles'||name==='organizer_grants'?'':',id'}`).bind(owner,...gate.values)),
 ]);
 if(!Number((results[0].results[0] as {allowed:number})?.allowed))throw new OrganizerConflict('租约已过期，或此账号未授权备份。','LEASE_LOST');
 const tables=Object.fromEntries(SNAPSHOT_TABLES.map((name,i)=>[name,results[i+1].results])) as Record<typeof SNAPSHOT_TABLES[number],Record<string,unknown>[]>;
 const counts=Object.fromEntries(SNAPSHOT_TABLES.map(name=>[name,tables[name].length]));
 const businessTables={tasks:tables.tasks,spaces:tables.spaces,inbox_entries:tables.inbox_entries,task_changes:tables.task_changes,organizer_profiles:tables.organizer_profiles.map(({last_check:_check,last_result:_result,...row})=>row),task_imports:tables.task_imports};
 return {format:'liubai-snapshot' as const,version:1,accountKey:await accountKey(owner),createdAt:new Date().toISOString(),businessHash:await digest(canonicalJSON(businessTables)),snapshotHash:await digest(canonicalJSON(tables)),hashAlgorithm:'sha256-canonical-json-v1',counts,tables};
}
