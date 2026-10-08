import express from 'express';
import crypto from 'node:crypto';
import {validateSource,extractDocument,extractedDraft} from './extraction.js';
import {extractCsv} from './csv.js';
import {cleanDraft,workflowReview,buildRecord,exportInvoice,suggestions,validateCatalog} from './workflow.js';
import {conflict} from './storage.js';

export function invoiceRouter({repository,clients,apiKey,model,validationOnly=false,extract=extractDocument}) {
 const router=express.Router();const busy=new Set();
 const extractionEnabled=!validationOnly&&Boolean(apiKey);
 router.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!['GET','HEAD'].includes(req.method)){
   const origin=req.get('origin');
   if((origin&&new URL(origin).host!==req.get('host'))||req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'Origen no autorizado.'});
  }
  next();
 });
 router.get('/config',(_req,res)=>res.json({clients,storage:repository.mode,extractionEnabled,validationOnly,exportEnabled:!validationOnly,automaticShWrites:false}));
 router.use('/:cid',(req,res,next)=>{
  if(!clients.some(c=>c.id===req.params.cid))return res.status(403).json({error:'Cliente fuera del piloto de cocina.'});
  req.invoiceCid=req.params.cid;next();
 });
 const safe=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
 const actor=req=>req.session?.username||req.session?.id||'reviewer';
 const view=r=>({...r,source:r.source?{name:r.source.name,type:r.source.type,hash:r.source.hash}:null});
 const load=async(req)=>{if(!/^[0-9a-f-]{36}$/.test(req.params.id))throw Object.assign(new Error('Factura no encontrada.'),{status:404});const r=await repository.get(req.invoiceCid,req.params.id);if(!r)throw Object.assign(new Error('Factura no encontrada.'),{status:404});return r;};
 router.get('/:cid/catalog',safe(async(req,res)=>res.json(await repository.catalog(req.invoiceCid))));
 router.put('/:cid/catalog',safe(async(req,res)=>{
  if(req.session?.role!=='Superadmin')return res.status(403).json({error:'Solo administración puede actualizar el catálogo.'});
  const catalog=validateCatalog(req.body,req.invoiceCid);await repository.putCatalog(req.invoiceCid,catalog);res.json({items:catalog.items.length});
 }));
 router.get('/:cid/invoices',safe(async(req,res)=>res.json((await repository.list(req.invoiceCid)).map(r=>({id:r.id,version:r.version,status:r.status,folio:r.draft.folio,supplier:r.draft.supplier,net:r.draft.net,date:r.draft.date,updatedAt:r.updatedAt,existingInSh:r.existingInSh})))));
 router.get('/:cid/invoices/:id',safe(async(req,res)=>res.json(view(await load(req)))));
 router.get('/:cid/invoices/:id/source',safe(async(req,res)=>{
  const r=await load(req);if(!r.source)return res.status(404).json({error:'Sin original.'});
  res.set({'Content-Type':r.source.type,'X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(r.source.name)}`,'Content-Security-Policy':"sandbox; default-src 'none'"}).send(Buffer.from(r.source.data,'base64'));
 }));
 router.post('/:cid/documents',safe(async(req,res)=>{
  const cid=req.invoiceCid;
  if(busy.has(cid))return res.status(429).json({error:'Ya hay una lectura en curso para este cliente.'});
  busy.add(cid);
  try{
   const source=await validateSource(req.body.file);
   const prior=await repository.list(cid);
   const folio=typeof req.body.folio==='string'?req.body.folio:'';
   const sourceIdentity=source.type==='text/csv'?source.hash+':'+folio:source.hash;
   const existing=prior.find(r=>(r.source?.identity??r.source?.hash)===sourceIdentity);
   if(existing)return res.status(409).json({error:'Este documento ya está guardado. Abre la factura existente.',id:existing.id});
   let extraction;
   if(source.type==='text/csv')extraction={result:extractCsv(source,folio),model:'csv',usage:null};
   else if(req.body.manual===true||!extractionEnabled)extraction={result:{lines:[],warnings:[]},model:'manual',usage:null};
   else { try { extraction=await extract(source,{apiKey,model}); } catch(error) { extraction={result:{lines:[],warnings:[error.message]},model:'failed',usage:null}; } }
   source.identity=sourceIdentity;
   const draft=extractedDraft(extraction.result,cid);const record=buildRecord(draft,{source,actor:actor(req)});
   record.draft.id=record.id;record.extraction=extraction;
   await repository.save(record,0);res.status(201).json(view(record));
  }finally{busy.delete(cid);}
 }));
 router.post('/:cid/invoices',safe(async(req,res)=>{
  const draft=cleanDraft({...req.body.draft,clientId:req.invoiceCid,id:crypto.randomUUID()});const record=buildRecord(draft,{actor:actor(req)});record.draft.id=record.id;
  await repository.save(record,0);res.status(201).json(view(record));
 }));
 router.put('/:cid/invoices/:id',safe(async(req,res)=>{
  const prior=await load(req);if(req.body.version!==prior.version)throw conflict();
  const draft=cleanDraft({...req.body.draft,id:prior.id,clientId:req.invoiceCid});
  const record=buildRecord(draft,{prior,actor:actor(req)});await repository.save(record,prior.version);res.json(view(record));
 }));
 router.post('/:cid/invoices/:id/extract',safe(async(req,res)=>{
   if(!extractionEnabled)return res.status(403).json({error:'La lectura automática está desactivada en esta prueba.'});
  const prior=await load(req);if(req.body.version!==prior.version)throw conflict();
  if(!prior.source)throw new Error('Esta factura no tiene original guardado.');
  if(busy.has(req.invoiceCid))return res.status(429).json({error:'Ya hay una lectura en curso.'});
  busy.add(req.invoiceCid);
  try{
   const extraction=prior.source.type==='text/csv'?{result:extractCsv(prior.source,prior.draft.folio),model:'csv',usage:null}:await extract(prior.source,{apiKey,model});
   const draft=extractedDraft(extraction.result,req.invoiceCid);draft.id=prior.id;
   const record=buildRecord(draft,{prior,actor:actor(req)});record.extraction=extraction;
   await repository.save(record,prior.version);res.json(view(record));
  }finally{busy.delete(req.invoiceCid);}
 }));
 router.post('/:cid/invoices/:id/review',safe(async(req,res)=>{
  const record=await load(req);const draft=req.body.draft?cleanDraft({...req.body.draft,id:record.id,clientId:req.invoiceCid}):record.draft;
  const [catalog,records]=await Promise.all([repository.catalog(req.invoiceCid),repository.list(req.invoiceCid)]);
  res.json({...workflowReview(draft,catalog,records),suggestions:draft.lines.map(l=>suggestions(draft,l,catalog,records))});
 }));
 router.post('/:cid/invoices/:id/confirm',safe(async(req,res)=>{
  const prior=await load(req);if(req.body.version!==prior.version)throw conflict();
  const [catalog,records]=await Promise.all([repository.catalog(req.invoiceCid),repository.list(req.invoiceCid)]);
  const report=workflowReview(prior.draft,catalog,records);
  if(!report.canConfirm)return res.status(422).json({error:'La factura tiene puntos pendientes.',report});
  if(req.body.reviewed!==true)return res.status(400).json({error:'Confirma la revisión del original.'});
  const record=buildRecord(prior.draft,{prior,status:'confirmed',actor:actor(req),report});await repository.save(record,prior.version);res.json(view(record));
 }));
 router.get('/:cid/invoices/:id/export',safe(async(req,res)=>{
  if(validationOnly)return res.status(403).json({error:'Esta sección es solo de validación; la exportación a SH está desactivada.'});
  const record=await load(req);res.json(exportInvoice(record,await repository.catalog(req.invoiceCid),await repository.list(req.invoiceCid)));
 }));
 router.use((error,_req,res,_next)=>res.status(error.status||400).json({error:error.status===500?'No se pudo completar la operación.':error.message}));
 return router;
}
