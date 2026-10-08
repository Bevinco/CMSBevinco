import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {invoicePeriod,buildPeriodOptions} from '../server/invoicing/navigation.js';
import {invoiceRouter} from '../server/invoicing/router.js';

test('navigation uses the recorded SH period, never the document date or current selection',()=>{
 const pending={date:'2026-01-03'}, loaded={date:'2026-01-03',existingInSh:{period:12}};
 assert.equal(invoicePeriod(pending),'unassigned');assert.equal(invoicePeriod(loaded),'12');
 const before=JSON.stringify([pending,loaded]);
 const options=buildPeriodOptions([pending,loaded],[{id:'11',startsAt:'2026-01-01',endsAt:'2026-01-07'}]);
 assert.deepEqual(options.map(p=>p.id),['12','11','unassigned']);
 assert.match(options[0].label,/fechas por actualizar/);assert.match(options[1].label,/01\/01\/2026 – 07\/01\/2026/);
 assert.equal(JSON.stringify([pending,loaded]),before);
});
test('deduplicates known periods, keeps empty periods and unassigned documents visible',()=>{
 const options=buildPeriodOptions([{existingInSh:{period:'9'}},{existingInSh:{period:'9'}},{existingInSh:{period:null}}],[{id:'10'},{id:'9'},{id:'8'}]);
 assert.deepEqual(options.map(p=>p.id),['10','9','8','unassigned']);
});
test('period metadata endpoint enforces the same client allowlist before reading',async t=>{
 const calls=[];const app=express();app.use('/api',invoiceRouter({repository:{mode:'local'},clients:[{id:'demo'}],periodsForClient:async cid=>{calls.push(cid);return [{id:'10'}];}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}/api`;
 assert.equal((await fetch(base+'/other/periods')).status,403);assert.deepEqual(calls,[]);
 const response=await fetch(base+'/demo/periods');assert.equal(response.status,200);assert.deepEqual(await response.json(),[{id:'10'}]);assert.deepEqual(calls,['demo']);
});
