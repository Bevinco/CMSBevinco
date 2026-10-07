// Strict RFC4180 reader. Only Sculpture's explicit invoice export columns are
// recognized; documentary taxes/totals absent from that file remain unknown.
export function parseCsv(text){
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(quoted)quoted=false;else if(value==='')quoted=true;else throw new Error('Comillas CSV inválidas.');}
  else if(c===','&&!quoted){row.push(value);value='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}
  else value+=c;
 }
 if(quoted)throw new Error('CSV con comillas sin cerrar.');row.push(value);if(row.some(Boolean))rows.push(row);
 if(rows.length>1000)throw new Error('Máximo 999 líneas CSV.');
 const header=rows.shift()?.map(x=>x.replace(/^\uFEFF/,'').trim());
 if(!header||new Set(header).size!==header.length)throw new Error('Encabezados CSV inválidos.');
 for(const key of ['item_name','quantity_of_purchase','total_cost','invoice_number','invoice_date','vendor_name'])if(!header.includes(key))throw new Error(`Falta columna ${key}. Usa el CSV de facturas de SH.`);
 return rows.map(r=>{if(r.length!==header.length)throw new Error('Cantidad de columnas CSV inconsistente.');return Object.fromEntries(header.map((h,i)=>[h,r[i]]));});
}
export function extractCsv(source,selectedFolio=''){
 const rows=parseCsv(Buffer.from(source.data,'base64').toString('utf8'));
 const groups=[...new Set(rows.map(r=>JSON.stringify([r.vendor_name,r.invoice_number,r.invoice_date])))];
 const group=groups.filter(g=>!selectedFolio||JSON.parse(g)[1]===selectedFolio);
 if(group.length!==1)throw new Error('El CSV contiene varias facturas: indica un folio único para revisar una por vez.');
 const [supplier,folio,date]=JSON.parse(group[0]);const selected=rows.filter(r=>JSON.stringify([r.vendor_name,r.invoice_number,r.invoice_date])===group[0]);
 const number=v=>v!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
 return {supplier,supplierRut:null,folio,date,net:null,vat:null,otherTaxes:null,total:null,warnings:['CSV de compras SH: falta encabezado fiscal original. Completa RUT, neto, IVA, otros impuestos y total documental.'],lines:selected.map(r=>({description:r.item_name,productCode:r.product_code,quantity:number(r.quantity_of_purchase),purchaseUnit:r.unit_of_measure,sourcePresentation:[r.pack_description,r.package_description,r.package_size_numeric,r.size_numeric,r.unit_of_measure].filter(Boolean).join(' '),printedUnitPrice:number(r.cost),printedLineTotal:number(r.total_cost),netLineTotal:number(r.total_cost),priceIncludesVat:false,kind:'food',note:''}))};
}
