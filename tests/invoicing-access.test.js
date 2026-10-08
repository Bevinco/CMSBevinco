import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {invoiceAccess} from '../server/invoicing/access.js';
import {invoiceRouter} from '../server/invoicing/router.js';
import {localRepository} from '../server/invoicing/storage.js';

test('private validation rejects other admins, API identities, removed users and missing configuration',async()=>{
 let user={id:'owner'};
 const policy=invoiceAccess({enabled:true,reviewerId:'owner',findUser:async()=>user});
 assert.equal(await policy.allowed({id:'owner'}),true);
 assert.equal(await policy.allowed({id:'other',role:'Superadmin'}),false);
 assert.equal(await policy.allowed({id:'owner',apiTokenId:'token',role:'Superadmin'}),false);
 user=null;assert.equal(await policy.allowed({id:'owner'}),false);
 user={id:'owner',active:false};assert.equal(await policy.allowed({id:'owner'}),false);
 for(const configuration of [{enabled:false,reviewerId:'owner'},{enabled:true,reviewerId:''}]){
   assert.equal(await invoiceAccess({...configuration,findUser:()=>{throw Error('must not read');}}).allowed({id:'owner'}),false);
 }
});

test('private HTML, assets and API share access; validation saves originals without extraction or SH export',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'invoice-private-'));
 const repo=localRepository(path.join(dir,'review.sqlite'));
 await fs.mkdir(path.join(dir,'web','assets'),{recursive:true});
 await fs.writeFile(path.join(dir,'web','revision-facturas.html'),'private-review');
 await fs.writeFile(path.join(dir,'web','assets','app.js'),'private-app');
 t.after(async()=>{repo.close();await fs.rm(dir,{recursive:true,force:true});});
 let enabled=true,extractions=0;
 const policy=()=>invoiceAccess({enabled,reviewerId:'owner',findUser:async()=>({id:'owner'}),readSession:req=>req.get('x-test-user')?{id:req.get('x-test-user'),role:'Superadmin'}:null});
 const guard=(req,res,next)=>policy().requireAccess(req,res,next);
 const app=express();app.use(express.json());
 app.use('/revision-facturas',guard,express.static(path.join(dir,'web'),{index:'revision-facturas.html',fallthrough:false}));
 app.use('/api/invoicing',guard,invoiceRouter({repository:repo,clients:[{id:'demo-kitchen'}],validationOnly:true,apiKey:'present-but-never-used',extract:async()=>{extractions++;throw Error('Paid extraction forbidden');}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=(route,{user='owner',method='GET',body,html=false}={})=>fetch(base+route,{redirect:'manual',method,headers:{Accept:html?'text/html':'application/json','Content-Type':'application/json',...(user?{'x-test-user':user}:{})},body:body?JSON.stringify(body):undefined});
 for(const route of ['/revision-facturas/','/revision-facturas/revision-facturas.html','/revision-facturas/assets/app.js','/api/invoicing/config','/api/invoicing/demo-kitchen/invoices']){
   assert.equal((await call(route,{user:'other'})).status,403);
   assert.equal((await call(route,{user:null})).status,401);
   assert.equal((await call(route)).status,200);
 }
 assert.equal((await call('/revision-facturas/',{user:null,html:true})).status,302);
 const config=await (await call('/api/invoicing/config')).json();
 assert.equal(config.extractionEnabled,false);assert.equal(config.exportEnabled,false);assert.equal(config.automaticShWrites,false);
 const file={name:'demo.png',type:'image/png',data:Buffer.from('89504e470d0a1a0a','hex').toString('base64')};
 const response=await call('/api/invoicing/demo-kitchen/documents',{method:'POST',body:{file,manual:false}});assert.equal(response.status,201);
 let record=await response.json();const route='/api/invoicing/demo-kitchen/invoices/'+record.id;
 assert.equal(record.extraction.model,'manual');
 assert.equal((await call(route+'/extract',{method:'POST',body:{version:record.version}})).status,403);
 assert.equal((await call(route+'/export')).status,403);
 assert.equal((await call(route+'/source',{user:'other'})).status,403);
 assert.equal((await call(route+'/source')).headers.get('Cache-Control'),'no-store');
 record.draft.folio='PRIVATE-001';
 const saved=await call(route,{method:'PUT',body:{draft:record.draft,version:record.version}});assert.equal(saved.status,200);
 assert.equal((await (await call(route)).json()).draft.folio,'PRIVATE-001');
 assert.equal(extractions,0);
 enabled=false;
 for(const route of ['/revision-facturas/','/api/invoicing/config'])assert.equal((await call(route)).status,404);
});
