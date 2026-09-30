import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source=await readFile(new URL('../lib/task-filters.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {matchesTimeRange:matches,calendarOffset}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const task={due:'',deadline:'',done:false};

test('today and tomorrow respect both planned dates and deadlines',()=>{
 const both={...task,due:'2026-09-30',deadline:'2026-10-01'};
 assert.equal(matches(both,'今天','2026-09-30'),true);
 assert.equal(matches(both,'明天','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-09-29'},'今天','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-10-02'},'明天','2026-09-30'),false);
});

test('near days and weeks have inclusive natural-calendar boundaries',()=>{
 assert.equal(calendarOffset('2026-12-31',1),'2027-01-01');
 assert.equal(calendarOffset('2028-02-28',1),'2028-02-29');
 assert.equal(matches({...task,due:'2026-10-02'},'近 3 天','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-10-03'},'近 3 天','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-10-04'},'本周','2026-09-30'),true);
 assert.equal(matches({...task,due:'2026-10-05'},'本周','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-10-05'},'以后','2026-10-04'),true);
});

test('unplanned and rearrange filters exclude deadlines and completed history correctly',()=>{
 assert.equal(matches(task,'未排期','2026-09-30'),true);
 assert.equal(matches({...task,deadline:'2026-10-01'},'未排期','2026-09-30'),false);
 assert.equal(matches({...task,due:'2026-09-29'},'待重新安排','2026-09-30'),true);
 assert.equal(matches({...task,deadline:'2026-09-29',done:true},'待重新安排','2026-09-30'),false);
});
