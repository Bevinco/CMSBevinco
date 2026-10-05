import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { reviewDraft, parseReviewFile } from '../../server/invoicing/review.js';
import type { Draft, Line } from './types';
import './review.css';
const id = () => crypto.randomUUID();
const blankLine = (): Line => ({id:id(),description:'',kind:'food',quantity:null,netLineTotal:null,purchaseUnit:'',costBasis:'',unitsPerPurchaseUnit:null,contentPerUnit:{value:null,unit:'g'},measuredTotalKg:null,reviewed:false,note:''});
const blank = (): Draft => ({id:id(),clientId:'28922',supplier:'',supplierRut:'',documentType:'factura',folio:'',date:'',net:null,vat:null,otherTaxes:0,total:null,taxExceptionReviewed:false,lines:[blankLine()]});
const money = (n:number) => new Intl.NumberFormat('es-CL',{maximumFractionDigits:3}).format(n);
function NumberField({label,value,onChange}:{label:string,value:number|null,onChange:(v:number|null)=>void}) {
  return <label>{label}<input type="number" min="0" step="any" value={value??''} onChange={e=>onChange(e.target.value===''?null:e.target.valueAsNumber)}/></label>;
}
function App() {
  const [draft,setDraft]=useState<Draft>(blank);
  const [file,setFile]=useState<File|null>(null);
  const [url,setUrl]=useState('');
  const [saved,setSaved]=useState<Draft[]>([]);
  const [notice,setNotice]=useState('');
  const report=reviewDraft(draft,saved);
  useEffect(()=>{if(!file){setUrl('');return;} const u=URL.createObjectURL(file);setUrl(u);return()=>URL.revokeObjectURL(u);},[file]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  const patch=(change:Partial<Draft>)=>{setDraft(d=>({...d,...change,taxExceptionReviewed: ('net' in change || 'vat' in change) ? false : (change.taxExceptionReviewed ?? d.taxExceptionReviewed)}));setNotice('');};
  const linePatch=(index:number,change:Partial<Line>)=>patch({lines:draft.lines.map((l,i)=>i===index?{...l,...change,reviewed:change.reviewed??false}:l)});
  function selectFile(f:File|undefined) {
    if(!f)return;
    if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(f.type)||f.size>10*1024*1024){setNotice('Usa un PDF, JPG, PNG o WEBP de hasta 10 MB.');return;}
    if(file&&!window.confirm('Cambiar el documento inicia una factura vacía. Descarga antes el borrador si quieres conservarlo.'))return;
    setFile(f);setDraft(blank());setNotice('Documento abierto. Ingresa los datos junto al original; esta prueba aún no realiza lectura automática.');
  }
  async function restore(f:File|undefined) {
    if(!f)return;
    if(f.size>2*1024*1024){setNotice('El borrador supera 2 MB.');return;}
    try {
      const restored=parseReviewFile(await f.text());
      if(!window.confirm('¿Abrir este borrador? Sustituirá los datos actuales. Abre primero su factura original si necesitas verla al lado.'))return;
      setDraft(restored);setNotice('Borrador recuperado. Comprueba que el documento visible corresponde al mismo proveedor y folio; el archivo JSON no contiene la factura original.');
    } catch {setNotice('No se pudo abrir: usa un borrador JSON descargado desde esta prueba.');}
  }
  function download() {
    const blob=new Blob([JSON.stringify({version:1,status:'draft',documentName:file?.name??null,invoice:draft,validation:report.errors},null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='revision-factura-borrador.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
    setSaved(rows=>[...rows.filter(r=>r.id!==draft.id),structuredClone(draft)]);setNotice('Borrador descargado. Conserva también la factura original. No se ha registrado en CMS ni en SH.');
  }
  function example() {
    if((file||draft.supplier||draft.lines[0]?.description)&&!window.confirm('¿Reemplazar el borrador por un ejemplo ficticio? Descarga primero los cambios que quieras conservar.'))return;
    setFile(null);setDraft({...blank(),clientId:'demo-kitchen',supplier:'Proveedor de ejemplo',supplierRut:'11111111-1',folio:'DEMO-001',date:'2026-01-01',net:20000,vat:3800,total:23800,lines:[{...blankLine(),description:'Producto ficticio — caja de 4 bolsas de 2,5 kg',quantity:2,netLineTotal:20000,purchaseUnit:'case',costBasis:'kg',unitsPerPurchaseUnit:4,contentPerUnit:{value:2.5,unit:'kg'},reviewed:true}]});setNotice('Ejemplo ficticio: 2 cajas × 4 bolsas × 2,5 kg = 20 kg; costo neto $1.000/kg.');
  }
  return <main>
    <header><div><span className="brand">BEVINCO / COCINA</span><h1>Revisión de facturas</h1><p>Original, cantidades y costos netos en un mismo lugar.</p></div><span className="badge">Prueba · borradores</span></header>
    <aside className="intro">Prueba local: los archivos se abren en tu navegador. Descarga el borrador antes de cerrar; los cambios no se guardan automáticamente. La lectura automática y la asociación al catálogo SH están pendientes.</aside>
    <div className="toolbar"><label className="upload">Abrir factura<input aria-label="Abrir factura" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>{selectFile(e.target.files?.[0]);e.target.value='';}}/></label><label className="upload">Recuperar borrador<input aria-label="Recuperar borrador" type="file" accept="application/json,.json" onChange={e=>{void restore(e.target.files?.[0]);e.target.value='';}}/></label><button onClick={example}>Probar ejemplo ficticio</button><button onClick={download}>Descargar borrador</button></div>
    {notice&&<p role="status" className="notice">{notice}</p>}
    <div className="workspace"><section className="viewer"><h2>Documento original</h2>{file?<><p>{file.name}</p><a href={url} target="_blank" rel="noreferrer">Abrir original en otra pestaña</a>{file.type==='application/pdf'?<iframe title="Factura original" src={url}/>:<img alt="Factura original" src={url}/>}</>:<div className="empty">Abre una factura PDF o una foto para revisarla aquí.<br/>Puedes probar los cálculos con el ejemplo ficticio.</div>}</section>
    <section className="editor"><h2>Datos de la factura</h2><p>{draft.clientId==='28922'?'Piloto: El Muelle Cocina · 28922':'Ejemplo ficticio · sin cliente real'}</p>
      <div className="fields"><label>Proveedor<input value={draft.supplier} onChange={e=>patch({supplier:e.target.value})}/></label><label>RUT proveedor<input value={draft.supplierRut} onChange={e=>patch({supplierRut:e.target.value})}/></label><label>Folio<input value={draft.folio} onChange={e=>patch({folio:e.target.value})}/></label><label>Fecha<input type="date" value={draft.date} onChange={e=>patch({date:e.target.value})}/></label></div>
      <div className="section-title"><h2>Productos y cargos</h2><button onClick={()=>patch({lines:[...draft.lines,blankLine()]})}>Agregar línea</button></div>
      {draft.lines.map((line,i)=><article className="line" key={line.id}><div className="section-title"><h3>Línea {i+1}</h3><button aria-label={`Quitar línea ${i+1}`} onClick={()=>{if(window.confirm('¿Quitar esta línea del borrador?'))patch({lines:draft.lines.filter((_,n)=>n!==i)});}}>Quitar</button></div>
        <label>Descripción en factura<input value={line.description} onChange={e=>linePatch(i,{description:e.target.value})}/></label>
        <label>Tipo<select value={line.kind} onChange={e=>linePatch(i,{kind:e.target.value as Line['kind']})}><option value="food">Alimento</option><option value="delivery">Despacho</option><option value="supply">Insumo no alimentario</option></select></label>
        <div className="fields"><NumberField label="Cantidad comprada" value={line.quantity} onChange={v=>linePatch(i,{quantity:v})}/><NumberField label="Importe neto de la línea ($)" value={line.netLineTotal} onChange={v=>linePatch(i,{netLineTotal:v})}/></div>
        {line.kind==='food'&&<><div className="fields"><label>Unidad de compra<select value={line.purchaseUnit} onChange={e=>linePatch(i,{purchaseUnit:e.target.value})}><option value="">Por confirmar</option>{[['kg','Kilos'],['g','Gramos'],['L','Litros'],['ml','Mililitros'],['unit','Unidad / envase'],['case','Caja / pack']].map(([v,t])=><option value={v} key={v}>{t}</option>)}</select></label><label>Costear por<select value={line.costBasis} onChange={e=>linePatch(i,{costBasis:e.target.value})}><option value="">Por confirmar</option><option value="kg">Kilo</option><option value="unit">Unidad</option><option value="L">Litro</option></select></label></div>
        {['case','unit'].includes(line.purchaseUnit)&&<><NumberField label="Unidades contenidas por caja o envase" value={line.unitsPerPurchaseUnit} onChange={v=>linePatch(i,{unitsPerPurchaseUnit:v})}/>{line.costBasis!=='unit'&&<div className="fields"><NumberField label="Contenido de cada unidad" value={line.contentPerUnit.value} onChange={v=>linePatch(i,{contentPerUnit:{...line.contentPerUnit,value:v}})}/><label>Unidad del contenido<select value={line.contentPerUnit.unit} onChange={e=>linePatch(i,{contentPerUnit:{...line.contentPerUnit,unit:e.target.value}})}>{['g','kg','ml','L'].map(v=><option key={v}>{v}</option>)}</select></label></div>}</>}
        {line.costBasis==='kg'&&<NumberField label="Peso real total comprado (kg, opcional)" value={line.measuredTotalKg} onChange={v=>linePatch(i,{measuredTotalKg:v})}/>}</>}
        <label>{line.kind==='food'?'Duda o aclaración pendiente':'Tratamiento del cargo / insumo'}<input value={line.note} onChange={e=>linePatch(i,{note:e.target.value})}/></label>
        {line.kind==='food'&&<label className="check"><input type="checkbox" checked={line.reviewed} onChange={e=>linePatch(i,{reviewed:e.target.checked})}/>He verificado cantidad, contenido y unidad de costeo.</label>}
        {report.results[i].cost&&<p className="cost">{line.reviewed?'Cálculo revisado':'Cálculo provisional'}: {money(report.results[i].cost!.baseQuantity)} {line.costBasis==='unit'?'unidades':line.costBasis} · ${money(report.results[i].cost!.netCostPerBaseUnit)} netos/{line.costBasis==='unit'?'unidad':line.costBasis}</p>}
        {report.results[i].issues.length>0&&<p className="pending">{report.results[i].issues.join(' ')}</p>}
      </article>)}
      <h2>Conciliación de importes</h2><p>IVA y otros impuestos se usan solo para comprobar el documento; no se suman al costo del producto.</p><div className="fields">{([['net','Neto documental ($)'],['vat','IVA ($)'],['otherTaxes','Otros impuestos ($)'],['total','Total factura ($)']] as const).map(([key,label])=><NumberField key={key} label={label} value={draft[key]} onChange={v=>patch({[key]:v})}/>)}</div>
      <label className="check"><input type="checkbox" checked={draft.taxExceptionReviewed} onChange={e=>patch({taxExceptionReviewed:e.target.checked})}/>Revisé el tratamiento de IVA si es distinto del 19%.</label>
      <div className={report.readyForMapping?'summary ready':'summary'} aria-live="polite"><h2>{report.readyForMapping?'Cálculos listos para revisar equivalencias SH':`${report.errors.length} puntos pendientes`}</h2><p>Suma de líneas: ${money(report.sum)}</p>{report.errors.length>0&&<ul>{report.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>}<p>La comprobación de duplicados abarca solo los borradores descargados en esta sesión. No consulta facturas existentes en SH o CMS.</p><strong>Estado: borrador. No habilita carga ni importación.</strong></div>
    </section></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
