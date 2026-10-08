import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// task-filters has a runtime dependency on the shared taskDate helper.
const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../lib/task-filters.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',target:'node22',write:false,logLevel:'silent'});
const {matchesTimeRange:matches,calendarOffset}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const task={due:'',done:false};

test('today and tomorrow use one planned date, with due taking precedence over the legacy alias',()=>{
 const both={...task,due:'2026-09-30',deadline:'2026-10-01'};
 assert.equal(matches(both,'今天','2026-09-30'),true);
 assert.equal(matches(both,'明天','2026-09-30'),false);
 const legacy={...task,deadline:'2026-10-01'};
 assert.equal(matches(legacy,'今天','2026-09-30'),false);
 assert.equal(matches(legacy,'明天','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-09-29'},'今天','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-10-02'},'明天','2026-09-30'),false);
});

test('a stale legacy date cannot place a task in another time range or mark it for rearrangement',()=>{
 const conflicting={...task,due:'2026-10-06',deadline:'2026-09-29'};
 for(const range of ['今天','明天','近 3 天','本周','待重新安排','未排期'])assert.equal(matches(conflicting,range,'2026-09-30'),false,range);
 assert.equal(matches(conflicting,'以后','2026-09-30'),true);
 assert.equal(matches(conflicting,'全部时间','2026-09-30'),true);
});

test('three days means today and the next two dates, excluding the past and the fourth day',()=>{
 for(const [due,expected] of [['2026-09-29',false],['2026-09-30',true],['2026-10-01',true],['2026-10-02',true],['2026-10-03',false]])assert.equal(matches({...task,due},'近 3 天','2026-09-30'),expected,due);
});

test('this week ends on Sunday and later begins Monday, including when today is Sunday',()=>{
 assert.equal(matches({...task,due:'2026-10-04'},'本周','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-10-05'},'本周','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-10-04'},'本周','2026-10-04'),true);
 assert.equal(matches({...task,due:'2026-10-03'},'本周','2026-10-04'),false);
 assert.equal(matches({...task,due:'2026-10-05'},'以后','2026-10-04'),true);
 assert.equal(matches({...task,due:'2026-10-04'},'以后','2026-10-04'),false);
});

test('calendar offsets and filters handle year boundaries, leap days and DST dates',()=>{
 assert.equal(calendarOffset('2026-12-31',1),'2027-01-01');
 assert.equal(calendarOffset('2027-01-01',-1),'2026-12-31');
 assert.equal(calendarOffset('2028-02-28',1),'2028-02-29');
 assert.equal(calendarOffset('2028-02-29',1),'2028-03-01');
 assert.equal(calendarOffset('2027-02-28',1),'2027-03-01');
 assert.equal(calendarOffset('2026-03-08',1),'2026-03-09');
 assert.equal(calendarOffset('2026-11-01',1),'2026-11-02');
 assert.equal(matches({...task,due:'2027-01-02'},'近 3 天','2026-12-31'),true);
 assert.equal(matches({...task,due:'2028-03-01'},'近 3 天','2028-02-28'),true);
});

test('unplanned and rearrangement recognize legacy-only dates, cleared aliases and completed history',()=>{
 assert.equal(matches(task,'未排期','2026-09-30'),true);
 assert.equal(matches({...task,deadline:'2026-10-01'},'未排期','2026-09-30'),false);
 assert.equal(matches({...task,due:'',deadline:''},'未排期','2026-09-30'),true);
 assert.equal(matches({...task,deadline:'2026-09-29'},'待重新安排','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-09-29'},'待重新安排','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-09-29',done:true},'待重新安排','2026-09-30'),false);
 assert.equal(matches({...task,deadline:'2026-09-29',done:true},'待重新安排','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-09-30',done:true},'今天','2026-09-30'),true);
});
