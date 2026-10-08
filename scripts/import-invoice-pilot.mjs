// Private inputs stay outside this public repository. Dry-run is the default.
import fs from 'node:fs/promises';
import {supabaseRepository} from '../server/invoicing/storage.js';
import {validateCatalog, cleanDraft} from '../server/invoicing/workflow.js';
import {validateSource} from '../server/invoicing/extraction.js';

const file = process.argv[2];
if (!file || file.startsWith('--')) throw new Error('Uso: node scripts/import-invoice-pilot.mjs archivo-privado.json [--apply]');
const bundle = JSON.parse(await fs.readFile(file, 'utf8'));
const cid = '28922';
const catalog = validateCatalog(bundle.catalog, cid);
if (!Array.isArray(bundle.records) || bundle.records.length !== 6) throw new Error('Este piloto requiere exactamente seis facturas ya revisadas.');
const ids = new Set();
for (const record of bundle.records) {
  if (record.clientId !== cid || record.draft.clientId !== cid || record.id !== record.draft.id || !/^[0-9a-f-]{36}$/.test(record.id) || ids.has(record.id)) throw new Error('Identidad del piloto inválida.');
  ids.add(record.id);
  cleanDraft(record.draft);
  if (!record.existingInSh?.id) throw new Error('Solo se importan referencias ya existentes en SH.');
  const source = await validateSource(record.source);
  if (source.hash !== record.source.hash) throw new Error('El original no coincide con su huella.');
  record.version = 1;
  record.status = 'draft';
  record.report = null;
}
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'dry-run',invoices:bundle.records.length,catalogItems:catalog.items.length,bytes:Buffer.byteLength(JSON.stringify(bundle))}));
if (process.argv.includes('--apply')) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Falta conexión de almacenamiento.');
  const repository = supabaseRepository(url,key);
  // Never overwrite an existing review. Retry after partial import only skips
  // identical originals with the same IDs; conflicts stop the operation.
  const existing = await repository.list(cid);
  const oldCatalog = await repository.catalog(cid);
  if (oldCatalog.items.length && JSON.stringify(oldCatalog) !== JSON.stringify(catalog)) throw new Error('El catálogo existente difiere; no se reemplaza.');
  for (const record of bundle.records) {
    const prior = existing.find(item=>item.id===record.id);
    if (prior && prior.source?.hash !== record.source.hash) throw new Error('El registro existente difiere; no se reemplaza.');
  }
  if (!oldCatalog.items.length) await repository.putCatalog(cid,catalog);
  for (const record of bundle.records) {
    if (!existing.some(item=>item.id===record.id)) await repository.save(record,0);
    const saved = await repository.get(cid,record.id);
    if (saved?.source?.hash !== record.source.hash) throw new Error('La verificación de guardado no coincide.');
  }
  console.log('Seis referencias verificadas. No se modificó cms_store ni Sculpture.');
}
