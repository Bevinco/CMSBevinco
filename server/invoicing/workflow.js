import crypto from 'node:crypto';
import {parseReviewFile,reviewDraft,duplicateKey} from './review.js';
import {normalizeLabel,priceIncrease,mappingKey,suggestProducts} from './domain.js';

export function cleanDraft(input) {
 const d=parseReviewFile(JSON.stringify({version:1,status:'draft',invoice:input}));
 const str=v=>typeof v==='string'?v.slice(0,2000):'';
 const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;
 return {...d,id:str(d.id),supplierId:str(d.supplierId),warnings:Array.isArray(d.warnings)?d.warnings.slice(0,30).map(str):[],lines:d.lines.map(l=>({...l,sourcePresentation:str(l.sourcePresentation),productCode:str(l.productCode),productId:str(l.productId),presentationId:str(l.presentationId),targetQuantity:num(l.targetQuantity),mappingReviewed:l.mappingReviewed===true,acknowledgePrice:l.acknowledgePrice===true,learnMapping:l.learnMapping===true,provisional:l.provisional===true}))};
}
export function validateCatalog(catalog,cid) {
 if(catalog?.clientId!==cid||!Array.isArray(catalog.items)||catalog.items.length>10000||!Array.isArray(catalog.suppliers)||catalog.suppliers.length>2000)throw new Error('Catálogo inválido.');
 const keys=new Set();
 for(const i of catalog.items){
  if(!i||['productId','presentationId','name','unit','size'].some(k=>typeof i[k]!=='string'||!i[k]||i[k].length>500))throw new Error('Cada presentación requiere ID, nombre, unidad y contenido.');
  const key=i.productId+':'+i.presentationId;if(keys.has(key))throw new Error('Presentación repetida.');keys.add(key);
 }
 for(const s of catalog.suppliers)if(!s||!s.id||!s.name||typeof s.id!=='string'||typeof s.name!=='string')throw new Error('Proveedor inválido.');
 return {...catalog,clientId:cid,capturedAt:catalog.capturedAt||new Date().toISOString()};
}
const catalogSignature=i=>JSON.stringify([i.productId,i.presentationId,i.unit,i.size,i.baseUnit??null,i.baseUnits??null,i.validFormat!==false]);
export function workflowReview(draft,catalog,previous=[]) {
 const base=reviewDraft(draft,previous.map(r=>r.draft??r));
 const errors=[...base.errors];const warnings=[];const output=[];
 const supplier=catalog.suppliers.find(s=>s.id===draft.supplierId);
 if(!supplier)errors.push('Selecciona el proveedor registrado en SH.');
 if(supplier?.rut&&normalizeLabel(supplier.rut).replace(/[^0-9k]/g,'')!==normalizeLabel(draft.supplierRut).replace(/[^0-9k]/g,''))errors.push('El RUT no coincide con el proveedor SH seleccionado.');
 let delivery=0,nonInventory=0;
 for(const [n,line] of draft.lines.entries()){
  if(line.kind!=='food'){
   if(!line.reviewed)errors.push(`Línea ${n+1}: confirma el cargo o insumo.`);
   if(line.kind==='delivery')delivery+=line.netLineTotal??0;else nonInventory+=line.netLineTotal??0;
   continue;
  }
  const item=catalog.items.find(i=>i.productId===line.productId&&i.presentationId===line.presentationId);
  if(!item||item.active===false){errors.push(`Línea ${n+1}: selecciona producto y presentación del catálogo del cliente.`);continue;}
  if(item.validFormat===false)errors.push(`Línea ${n+1}: presentación SH incompleta; revisa su contenido antes de exportar.`);
  if(!line.mappingReviewed||!(line.targetQuantity>0))errors.push(`Línea ${n+1}: confirma equivalencia y cantidad en la presentación SH.`);
  if(!line.sourcePresentation.trim())errors.push(`Línea ${n+1}: describe el formato original para la equivalencia.`);
  if(line.provisional&&!line.note.trim())errors.push(`Línea ${n+1}: documenta el criterio provisional autorizado.`);
  // Known catalog contents must conserve the physical quantity independently
  // from the quantity entered by the reviewer. Never apply cooking yield.
  if(item.baseUnit&&item.baseUnits>0&&base.results[n].cost?.costBasis===item.baseUnit&&line.targetQuantity>0){
   const physical=base.results[n].cost.baseQuantity;
   if(Math.abs(line.targetQuantity*item.baseUnits-physical)>Math.max(1e-8,physical*1e-8))errors.push(`Línea ${n+1}: cantidad SH no conserva el contenido comprado.`);
  } else if(line.targetQuantity>0&&!line.note.trim())errors.push(`Línea ${n+1}: explica la conversión a SH cuando la unidad de costeo es distinta o el contenido no está definido.`);
  const unitPrice=line.netLineTotal/(line.targetQuantity||1);
  const references=(item.costs??[]).filter(c=>c.supplierId===draft.supplierId&&c.date<draft.date&&c.unit===item.unit&&Number.isFinite(c.netPrice)&&c.netPrice>0).sort((a,b)=>b.date.localeCompare(a.date));
  // Confirmed invoices supply exact IDs, unlike name-only historical candidates.
  for(const r of previous.filter(r=>r.status==='confirmed'&&r.id!==draft.id&&r.draft.date<draft.date&&r.draft.supplierId===draft.supplierId)){
   for(const l of r.draft.lines.filter(l=>l.productId===item.productId&&l.presentationId===item.presentationId))references.push({date:r.draft.date,netPrice:l.netLineTotal/l.targetQuantity,unit:item.unit});
  }
  references.sort((a,b)=>b.date.localeCompare(a.date));
  const increase=priceIncrease({currentNetCost:unitPrice,previousNetCost:references[0]?.netPrice,currentUnit:item.unit,previousUnit:references[0]?.unit,thresholdPercent:catalog.priceThresholdPercent??10});
  if(increase?.alert){warnings.push(`Línea ${n+1}: alza de ${increase.percent.toFixed(1)}% frente al ${references[0].date}.`);if(!line.acknowledgePrice||!line.note.trim())errors.push(`Línea ${n+1}: reconoce y explica el alza de precio.`);}
  if(!references.length)warnings.push(`Línea ${n+1}: sin costo anterior comparable por ID, proveedor y presentación.`);
  output.push({catalogSignature:catalogSignature(item),lineId:line.id,productId:item.productId,presentationId:item.presentationId,name:item.name,quantity:line.targetQuantity,unit:item.unit,size:item.size,code:item.code||'',unitPrice,net:line.netLineTotal,baseQuantity:base.results[n].cost?.baseQuantity??null,costBasis:line.costBasis,increase});
 }
 return {...base,errors:[...new Set(errors)],warnings,output,delivery,nonInventory,shTaxes:0,shTotal:base.sum,canConfirm:errors.length===0,supplier};
}
export function learnedMappings(records) {
 return records.filter(r=>r.status==='confirmed').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).flatMap(r=>r.draft.lines.filter(l=>l.kind==='food'&&l.learnMapping&&l.mappingReviewed&&!l.provisional&&l.measuredTotalKg==null).map(l=>({key:mappingKey({clientId:r.clientId,supplierId:r.draft.supplierId,sourceProduct:l.description,sourcePresentation:l.sourcePresentation}),productId:l.productId,presentationId:l.presentationId,factor:l.targetQuantity/l.quantity,catalogSignature:r.report?.output?.find(o=>o.lineId===l.id)?.catalogSignature,reviewed:true})));
}
export function suggestions(draft,line,catalog,records){
 if(!draft.supplierId||!line.description||!line.sourcePresentation)return [];
 return suggestProducts({clientId:draft.clientId,supplierId:draft.supplierId,sourceProduct:line.description,sourcePresentation:line.sourcePresentation,catalog:catalog.items.map(i=>({...i,clientId:draft.clientId})),mappings:learnedMappings(records).filter(rule=>catalog.items.some(i=>i.productId===rule.productId&&i.presentationId===rule.presentationId&&catalogSignature(i)===rule.catalogSignature))});
}
export function buildRecord(draft,{source=null,prior=null,status='draft',actor='unknown',report=null,existingInSh=null}={}) {
 const now=new Date().toISOString();
 return {id:prior?.id??crypto.randomUUID(),clientId:draft.clientId,version:(prior?.version??0)+1,status,duplicateKey:duplicateKey(draft),draft:{...draft,id:prior?.id??draft.id},source:prior?.source??source,extraction:prior?.extraction??null,existingInSh:prior?.existingInSh??existingInSh,createdAt:prior?.createdAt??now,updatedAt:now,confirmedAt:status==='confirmed'?now:null,report,audit:[...(prior?.audit??[]),{at:now,actor,action:status,version:(prior?.version??0)+1}].slice(-100)};
}
const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';
export function exportInvoice(record,catalog,previous=[]) {
 if(record.status!=='confirmed')throw new Error('Confirma la revisión antes de exportar.');
 if(record.existingInSh)throw new Error('Esta factura ya está en SH. No se genera un archivo que pueda duplicarla.');
 const report=workflowReview(record.draft,catalog,previous);
 if(!report.canConfirm)throw new Error(report.errors.join(' '));
 // Use extended net price to avoid rounded unit prices changing the total.
 // Header charges are a separate, explicit manual step: never duplicate them
 // on every product row or silently turn them into a food purchase.
 const columns=['vendor_name','invoice_number','invoice_date','item_name','product_code','quantity_of_purchase','unit_of_measure','pack_description','total_cost','total_tax'];
 const rows=report.output.map(l=>[report.supplier.name,record.draft.folio,record.draft.date,l.name,l.code,l.quantity,l.unit,l.size,l.net,0]);
 return {csv:'\uFEFF'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n',summary:{folio:record.draft.folio,clientId:record.clientId,supplier:report.supplier.name,totalDelivery:report.delivery,totalNonInventory:report.nonInventory,totalTaxes:0,totalNet:report.shTotal,steps:['Comprobar en SH que el folio/proveedor no esté ya cargado en el período abierto.','Importar productos asignando total_cost a Ext. Price; no a Unit Price.','Registrar una sola vez los cargos del encabezado indicados en este resumen.','Comprobar Taxes=0 y total neto antes de finalizar.'],importStatus:'Preparado para importación manual; no enviado a SH.'}};
}
