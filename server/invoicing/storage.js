import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const conflict = (message = 'La factura cambió o ya existe. Recarga antes de guardar.') => Object.assign(new Error(message), { status: 409 });

// Local review uses a separate SQLite database. Never reads or writes cms_store.
export function localRepository(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, version INTEGER NOT NULL, duplicate_key TEXT, source_hash TEXT, payload TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_duplicate ON invoices(client_id,duplicate_key) WHERE duplicate_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_source ON invoices(client_id,source_hash) WHERE source_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS catalogs(client_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  fs.chmodSync(filename, 0o600);
  return {
    mode: 'local',
    async list(cid) { return db.prepare('SELECT payload FROM invoices WHERE client_id=?').all(cid).map(r => JSON.parse(r.payload)); },
    async get(cid, id) { const r = db.prepare('SELECT payload FROM invoices WHERE client_id=? AND id=?').get(cid,id); return r ? JSON.parse(r.payload) : null; },
    async catalog(cid) { const r=db.prepare('SELECT payload FROM catalogs WHERE client_id=?').get(cid); return r ? JSON.parse(r.payload) : {clientId:cid,items:[],suppliers:[]}; },
    async putCatalog(cid, catalog) { db.prepare('INSERT INTO catalogs VALUES(?,?) ON CONFLICT(client_id) DO UPDATE SET payload=excluded.payload').run(cid,JSON.stringify(catalog)); },
    async save(record, expectedVersion) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior=db.prepare('SELECT version FROM invoices WHERE id=?').get(record.id);
        if ((prior?.version ?? 0) !== expectedVersion) throw conflict();
        if (prior) db.prepare('UPDATE invoices SET version=?,duplicate_key=?,source_hash=?,payload=? WHERE id=? AND client_id=?').run(record.version,record.duplicateKey,record.source?.identity??record.source?.hash??null,JSON.stringify(record),record.id,record.clientId);
        else db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?)').run(record.id,record.clientId,record.version,record.duplicateKey,record.source?.identity??record.source?.hash??null,JSON.stringify(record));
        db.exec('COMMIT'); return record;
      } catch (error) { db.exec('ROLLBACK'); if (String(error.message).includes('UNIQUE constraint')) throw conflict('Factura duplicada por folio/proveedor o archivo. Abre el registro existente.'); throw error; }
    },
    close() { db.close(); },
  };
}

// Production uses dedicated tables + an atomic RPC, installed by a reviewed migration.
export function supabaseRepository(url, key) {
  async function request(route, options={}) {
    const response=await fetch(`${url.replace(/\/$/,'')}/rest/v1/${route}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(20000)});
    const body=await response.json().catch(()=>null);
    if(!response.ok) { if(['23505','40001'].includes(body?.code)) throw conflict(); throw Object.assign(new Error('No se pudo acceder al almacenamiento de facturas.'),{status:503}); }
    return body;
  }
  const filter=cid=>`client_id=eq.${encodeURIComponent(cid)}`;
  return {
    mode:'supabase',
    async list(cid) { return (await request(`kitchen_invoices?${filter(cid)}&select=payload&limit=1000`)).map(r=>r.payload); },
    async get(cid,id) { return (await request(`kitchen_invoices?${filter(cid)}&id=eq.${encodeURIComponent(id)}&select=payload`))[0]?.payload??null; },
    async catalog(cid) { return (await request(`kitchen_catalogs?${filter(cid)}&select=payload`))[0]?.payload??{clientId:cid,items:[],suppliers:[]}; },
    async putCatalog(cid,payload) { await request('kitchen_catalogs?on_conflict=client_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:JSON.stringify({client_id:cid,payload})}); },
    async save(record,expectedVersion) { await request('rpc/save_kitchen_invoice',{method:'POST',body:JSON.stringify({record,expected_version:expectedVersion})}); return record; },
  };
}
