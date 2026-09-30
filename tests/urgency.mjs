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
const {effectiveQuadrant,urgencyInfo,dateInTimezone,taskDate}=await moduleFromSource('../lib/urgency.ts');
const prefs={urgentDays:3,timezone:'Asia/Shanghai'};
const base=Object.freeze({id:'fixture',title:'Example',note:'',quadrant:1,category:'工作',due:'',done:false,subtasks:Object.freeze([]),revision:7});
const at=value=>new Date(value);
test('legacy plan dates never become implicit deadlines, and derivation leaves persisted data untouched',()=>{
 const legacy=Object.freeze({...base,due:'2026-01-01'});
 assert.equal(effectiveQuadrant(legacy,prefs,at('2026-09-30T00:00:00Z')),1);
 const automatic=Object.freeze({...base,deadline:'2026-10-04',urgencyMode:'auto'});
 assert.equal(effectiveQuadrant(automatic,prefs,at('2026-10-01T00:00:00Z')),0);
 assert.equal(automatic.quadrant,1);assert.equal(automatic.revision,7);
});

test('automatic urgency crosses exactly at the account calendar midnight and preserves importance',()=>{
 const task={...base,deadline:'2026-10-04',urgencyMode:'auto'};
 assert.equal(effectiveQuadrant(task,prefs,at('2026-09-30T15:59:59Z')),1);
 assert.equal(effectiveQuadrant(task,prefs,at('2026-09-30T16:00:00Z')),0);
 assert.equal(effectiveQuadrant({...task,quadrant:3},prefs,at('2026-09-30T16:00:00Z')),2);
 assert.equal(dateInTimezone(at('2026-09-30T16:00:00Z'),prefs.timezone),'2026-10-01');
});

test('postponement, removing a deadline and manual overrides change only effective urgency',()=>{
 const now=at('2026-10-01T00:00:00Z'),task={...base,deadline:'2026-10-02',urgencyMode:'auto'};
 assert.equal(effectiveQuadrant(task,prefs,now),0);
 assert.equal(effectiveQuadrant({...task,deadline:'2026-10-10'},prefs,now),1);
 assert.equal(effectiveQuadrant({...task,deadline:''},prefs,now),1);
 assert.equal(effectiveQuadrant({...task,urgencyMode:'manualNormal'},prefs,now),1);
 assert.equal(effectiveQuadrant({...task,deadline:'',urgencyMode:'manualUrgent'},prefs,now),0);
});

test('overdue tasks remain urgent, completed tasks do not acquire automatic urgency, zero means deadline day',()=>{
 const task={...base,deadline:'2026-09-29',urgencyMode:'auto'},now=at('2026-10-01T00:00:00Z');
 assert.deepEqual([urgencyInfo(task,prefs,now).overdue,effectiveQuadrant(task,prefs,now)],[true,0]);
 const done=urgencyInfo({...task,done:true},prefs,now);assert.equal(done.overdue,false);assert.equal(done.automatic,false);assert.equal(done.quadrant,1);
 assert.equal(effectiveQuadrant({...task,deadline:'2026-10-02'},{...prefs,urgentDays:0},now),1);
 assert.equal(effectiveQuadrant({...task,deadline:'2026-10-01'},{...prefs,urgentDays:0},now),0);
});

test('DST uses calendar dates, not elapsed 24-hour windows, and time view respects both dates',()=>{
 const ny={urgentDays:3,timezone:'America/New_York'},task={...base,deadline:'2026-11-04',urgencyMode:'auto'};
 assert.equal(dateInTimezone(at('2026-11-01T05:30:00Z'),ny.timezone),'2026-11-01');
 assert.equal(urgencyInfo(task,ny,at('2026-11-01T05:30:00Z')).remaining,3);
 assert.equal(urgencyInfo(task,ny,at('2026-11-01T06:30:00Z')).remaining,3);
 assert.equal(taskDate({...task,due:'2026-11-02'}),'2026-11-02');
 assert.equal(taskDate({...task,due:'2026-11-08'}),'2026-11-04');
 assert.equal(taskDate(base),'');
});
