import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

// Run the production pure helpers, without a browser, network or task database.
async function moduleFromSource(path) {
 const source=await readFile(new URL(path,import.meta.url),'utf8');
 const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
 return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const {AccountBoundary,responseBelongsTo,accountDraftKey,readAccountDraft}=await moduleFromSource('../lib/frontend-session.ts');
const A='account-a',B='account-b';
function connected(key=A){const boundary=new AccountBoundary();boundary.beginVerification();boundary.adopt(key);return boundary;}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}

test('a late organizer response cannot replace the newly signed-in account',async()=>{
 const boundary=connected(),ticket=boundary.snapshot(),request=deferred();let displayed={owner:A};
 const apply=request.promise.then(result=>{if(boundary.accepts(ticket,result.accountKey))displayed=result;});
 boundary.beginVerification();boundary.adopt(B);displayed={owner:B};
 request.resolve({accountKey:A,owner:A,preferences:'private to A'});await apply;
 assert.deepEqual(displayed,{owner:B});
 assert.equal(boundary.accepts(boundary.snapshot(),B),true);
});

test('matching the current ref alone is insufficient: the response must carry the same account',()=>{
 const boundary=connected(),ticket=boundary.snapshot();
 assert.equal(boundary.accepts(ticket,B),false);
 assert.equal(boundary.accepts(ticket,undefined),false);
 assert.equal(responseBelongsTo({accountKey:B},A),false);
 assert.equal(responseBelongsTo({profile:{}},A),false);
 assert.equal(responseBelongsTo({accountKey:A},A),true);
 // A contradictory top-level owner must not be hidden by a nested account.
 assert.equal(responseBelongsTo({accountKey:B,account:{key:A}},A),false);
});

test('focus/pageshow revalidation invalidates earlier reads even when the account is unchanged',()=>{
 const boundary=connected(),beforeFocus=boundary.snapshot();
 boundary.beginVerification();
 assert.equal(boundary.accepts(beforeFocus,A),false);
 boundary.adopt(A);
 assert.equal(boundary.accepts(beforeFocus,A),false);
 assert.equal(boundary.accepts(boundary.snapshot(),A),true);
});

test('A to B to A cannot revive an earlier A response or undo callback ticket',()=>{
 const boundary=connected(),firstVisit=boundary.snapshot();
 boundary.beginVerification();boundary.adopt(B);
 boundary.beginVerification();boundary.adopt(A);
 assert.equal(boundary.accepts(firstVisit,A),false);
 assert.equal(boundary.accepts(boundary.snapshot(),A),true);
});

test('overlapping identity checks have distinct epochs, including before first login',()=>{
 const boundary=new AccountBoundary();
 const first=boundary.beginVerification(),second=boundary.beginVerification();
 assert.notEqual(first,second);
 assert.equal(boundary.epoch,second);
 assert.equal(boundary.accepts(boundary.snapshot(),A),false);
 boundary.adopt(A);
 assert.notEqual(boundary.epoch,first);
});

test('a focus event during a write conceals reads without invalidating its acknowledgement',()=>{
 const boundary=connected(),inFlightWriteEpoch=boundary.epoch,oldRead=boundary.snapshot();
 boundary.deferVerification();
 assert.equal(boundary.epoch,inFlightWriteEpoch);
 assert.equal(boundary.accepts(oldRead,A),false);
 // The write finishes; the deferred identity check must happen before showing data again.
 boundary.beginVerification();boundary.adopt(A);
 assert.equal(boundary.accepts(oldRead,A),false);
 assert.equal(boundary.accepts(boundary.snapshot(),A),true);
});

test('signout immediately rejects all old tickets until a fresh identity is adopted',()=>{
 const boundary=connected(),ticket=boundary.snapshot();boundary.clear();
 assert.equal(boundary.accepts(ticket,A),false);
 assert.equal(boundary.accepts(boundary.snapshot(),A),false);
 boundary.adopt(B);assert.equal(boundary.accepts(ticket,A),false);
});

const validDraft=v=>!!v&&typeof v==='object'&&typeof v.ownerKey==='string'&&typeof v.text==='string';
test('drafts stay with their owner through account switching and malformed storage',()=>{
 const storage=new Map([[accountDraftKey(A),JSON.stringify({ownerKey:A,text:'unsaved A'})],[accountDraftKey(B),JSON.stringify({ownerKey:B,text:'unsaved B'})]]);
 assert.notEqual(accountDraftKey(A),accountDraftKey(B));
 assert.equal(readAccountDraft(storage.get(accountDraftKey(A)),A,validDraft).text,'unsaved A');
 assert.equal(readAccountDraft(storage.get(accountDraftKey(B)),B,validDraft).text,'unsaved B');
 assert.equal(readAccountDraft(storage.get(accountDraftKey(A)),B,validDraft),null);
 for(const raw of [null,'broken json','null','{}',JSON.stringify({text:'unscoped legacy draft'})])assert.equal(readAccountDraft(raw,A,validDraft),null);
});

