import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// Bundle the production helpers, including runtime imports; no browser, network or task database.
const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../lib/urgency.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',target:'node22',write:false,logLevel:'silent'});
const {effectiveQuadrant,urgencyInfo,dateInTimezone,taskDate,withTaskDate,placeInQuadrant}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const prefs={urgentDays:3,timezone:'Asia/Shanghai'};
const base=Object.freeze({id:'fixture',title:'Example',note:'keep this note',quadrant:1,category:'工作',due:'',done:false,subtasks:Object.freeze([]),revision:7});
const at=value=>new Date(value);
const now=at('2026-10-08T04:00:00Z');

test('legacy tasks without a mode retain their original arrangement; explicit manual modes win',()=>{
 for(let quadrant=0;quadrant<4;quadrant++){
  const legacy=Object.freeze({...base,quadrant,due:'2026-01-01'});
  assert.equal(effectiveQuadrant(legacy,prefs,now),quadrant);
  assert.equal(Object.hasOwn(legacy,'urgencyMode'),false);
  assert.equal(effectiveQuadrant({...legacy,urgencyMode:'manualNormal'},prefs,now),quadrant<2?1:3);
  assert.equal(effectiveQuadrant({...legacy,due:'',urgencyMode:'manualUrgent'},prefs,now),quadrant<2?0:2);
 }
});

test('one planned date prefers due over the legacy alias and drives automatic urgency consistently',()=>{
 const task=Object.freeze({...base,due:'2026-10-12',deadline:'2026-10-01',urgencyMode:'auto'});
 assert.equal(taskDate(task),'2026-10-12');
 assert.deepEqual([urgencyInfo(task,prefs,now).remaining,effectiveQuadrant(task,prefs,now),urgencyInfo(task,prefs,now).overdue],[4,1,false]);
 const legacy=Object.freeze({...base,due:'',deadline:'2026-10-11',urgencyMode:'auto'});
 assert.equal(taskDate(legacy),'2026-10-11');
 assert.equal(effectiveQuadrant(legacy,prefs,now),0);
 assert.equal(task.quadrant,1);assert.equal(task.revision,7);assert.equal(task.deadline,'2026-10-01');
});

test('editing and clearing the date synchronize an existing alias without creating a new alias',()=>{
 const fresh=withTaskDate(base,'2026-10-11');
 assert.equal(fresh.due,'2026-10-11');assert.equal(Object.hasOwn(fresh,'deadline'),false);
 assert.equal(base.due,'');assert.equal(fresh.note,base.note);assert.equal(fresh.revision,base.revision);
 for(const oldAlias of ['2026-10-01',undefined]){
  const legacy=Object.freeze({...base,quadrant:0,deadline:oldAlias,urgencyMode:'auto'});
  const changed=withTaskDate(legacy,'2026-10-20');
  assert.equal(changed.due,'2026-10-20');assert.equal(changed.deadline,'2026-10-20');
  const cleared=withTaskDate(changed,'');
  assert.equal(cleared.due,'');assert.equal(cleared.deadline,'');
  const reloaded=JSON.parse(JSON.stringify(cleared));
  assert.equal(taskDate(reloaded),'');assert.equal(effectiveQuadrant(reloaded,prefs,now),0);
  assert.equal(reloaded.urgencyMode,'auto');assert.equal(legacy.deadline,oldAlias);
 }
});

test('auto without any date preserves all four stored quadrants and is not actively automatic',()=>{
 for(let quadrant=0;quadrant<4;quadrant++){
  const task=Object.freeze({...base,quadrant,deadline:'',urgencyMode:'auto'});
  const info=urgencyInfo(task,prefs,now);
  assert.equal(info.quadrant,quadrant);assert.equal(info.urgent,quadrant%2===0);
  assert.equal(info.automatic,false);assert.equal(info.remaining,null);assert.equal(info.overdue,false);
 }
});

test('three-day and zero-day thresholds include the planned day and overdue tasks',()=>{
 const task={...base,urgencyMode:'auto'};
 assert.equal(effectiveQuadrant({...task,due:'2026-10-12'},prefs,now),1);
 assert.equal(effectiveQuadrant({...task,due:'2026-10-11'},prefs,now),0);
 assert.equal(effectiveQuadrant({...task,due:'2026-10-09'},{...prefs,urgentDays:0},now),1);
 assert.equal(effectiveQuadrant({...task,due:'2026-10-08'},{...prefs,urgentDays:0},now),0);
 const late=urgencyInfo({...task,due:'2026-10-07'},{...prefs,urgentDays:0},now);
 assert.equal(late.quadrant,0);assert.equal(late.overdue,true);assert.equal(late.remaining,-1);
});

test('automatic urgency crosses at each account timezone midnight and preserves importance',()=>{
 const task={...base,due:'2026-10-11',urgencyMode:'auto'};
 for(const [timezone,before,midnight] of [
  ['Asia/Shanghai','2026-10-07T15:59:59Z','2026-10-07T16:00:00Z'],
  ['America/New_York','2026-10-08T03:59:59Z','2026-10-08T04:00:00Z'],
  ['UTC','2026-10-07T23:59:59Z','2026-10-08T00:00:00Z'],
 ]){
  const settings={...prefs,timezone};
  assert.equal(effectiveQuadrant(task,settings,at(before)),1,timezone);
  assert.equal(effectiveQuadrant(task,settings,at(midnight)),0,timezone);
  assert.equal(effectiveQuadrant({...task,quadrant:3},settings,at(midnight)),2,timezone);
  assert.equal(dateInTimezone(at(midnight),timezone),'2026-10-08');
 }
});

test('DST transitions count calendar dates rather than elapsed 24-hour periods',()=>{
 const settings={...prefs,timezone:'America/New_York'};
 for(const [due,instants] of [
  ['2026-11-04',['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z']],
  ['2026-03-11',['2026-03-08T06:59:59Z','2026-03-08T07:00:00Z']],
 ])for(const instant of instants){const info=urgencyInfo({...base,due,urgencyMode:'auto'},settings,at(instant));assert.equal(info.remaining,3);assert.equal(info.urgent,true);}
});

test('urgency counts leap days and year boundaries correctly',()=>{
 for(const [instant,due] of [
  ['2026-12-31T00:00:00Z','2027-01-03'],
  ['2028-02-28T00:00:00Z','2028-03-02'],
  ['2027-02-28T00:00:00Z','2027-03-03'],
 ])assert.equal(urgencyInfo({...base,due,urgencyMode:'auto'},prefs,at(instant)).remaining,3);
});

test('postponing the planned date relaxes auto urgency without rewriting importance or manual choices',()=>{
 const automatic=Object.freeze({...base,quadrant:3,due:'2026-10-09',deadline:'2026-10-09',urgencyMode:'auto'});
 assert.equal(effectiveQuadrant(automatic,prefs,now),2);
 const postponed=withTaskDate(automatic,'2026-10-20');
 assert.equal(effectiveQuadrant(postponed,prefs,now),3);
 assert.equal(postponed.quadrant,3);assert.equal(postponed.urgencyMode,'auto');assert.equal(automatic.due,'2026-10-09');
 assert.equal(effectiveQuadrant({...postponed,urgencyMode:'manualUrgent'},prefs,now),2);
});

test('completion stops automatic urgency and reopening recomputes it from the current date',()=>{
 const task=Object.freeze({...base,due:'2026-10-07',urgencyMode:'auto'});
 assert.equal(effectiveQuadrant(task,prefs,now),0);
 const done={...task,done:true},info=urgencyInfo(done,prefs,now);
 assert.equal(info.automatic,false);assert.equal(info.overdue,false);assert.equal(info.quadrant,1);
 assert.equal(effectiveQuadrant({...done,done:false},prefs,now),0);
 assert.equal(effectiveQuadrant(withTaskDate({...done,done:false},'2026-10-20'),prefs,now),1);
 assert.equal(task.quadrant,1);assert.equal(task.revision,7);
});

test('placing into the same effective quadrant is a true no-op, even when the stored column differs',()=>{
 const task=Object.freeze({...base,due:'2026-10-09',urgencyMode:'auto'});
 assert.equal(effectiveQuadrant(task,prefs,now),0);
 assert.equal(placeInQuadrant(task,0,prefs,now),task);
});

test('vertical placement preserves mode and stored urgency column for auto and legacy manual tasks',()=>{
 const task=Object.freeze({...base,due:'2026-10-09',urgencyMode:'auto'});
 const moved=placeInQuadrant(task,2,prefs,now);
 assert.equal(moved.quadrant,3);assert.equal(moved.urgencyMode,'auto');assert.equal(effectiveQuadrant(moved,prefs,now),2);
 assert.equal(effectiveQuadrant(withTaskDate(moved,'2026-10-20'),prefs,now),3);
 const restored=placeInQuadrant(moved,0,prefs,now);assert.equal(restored.quadrant,1);assert.equal(restored.urgencyMode,'auto');
 const legacy=Object.freeze({...base,quadrant:0,due:'2026-10-20'}),legacyMoved=placeInQuadrant(legacy,2,prefs,now);
 assert.equal(legacyMoved.quadrant,2);assert.equal(Object.hasOwn(legacyMoved,'urgencyMode'),false);
 const manual=placeInQuadrant({...base,urgencyMode:'manualNormal'},3,prefs,now);assert.equal(manual.urgencyMode,'manualNormal');assert.equal(manual.quadrant,3);
});

test('horizontal or diagonal placement explicitly overrides urgency, while restoring auto follows the date again',()=>{
 const urgent=Object.freeze({...base,due:'2026-10-09',urgencyMode:'auto'});
 for(const target of [1,3]){const moved=placeInQuadrant(urgent,target,prefs,now);assert.equal(moved.quadrant,target);assert.equal(moved.urgencyMode,'manualNormal');assert.equal(effectiveQuadrant(moved,prefs,now),target);}
 const manual=placeInQuadrant(urgent,1,prefs,now);assert.equal(effectiveQuadrant({...manual,urgencyMode:'auto'},prefs,now),0);
 const relaxed=Object.freeze({...base,due:'2026-10-20',urgencyMode:'auto'}),moved=placeInQuadrant(relaxed,0,prefs,now);
 assert.equal(moved.urgencyMode,'manualUrgent');assert.equal(moved.quadrant,0);assert.equal(effectiveQuadrant(withTaskDate(moved,''),prefs,now),0);
});
