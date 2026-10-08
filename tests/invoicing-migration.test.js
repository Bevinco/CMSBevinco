import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {buildRecord} from '../server/invoicing/workflow.js';
test('Postgres migration enforces optimistic version, duplicates and private access',async()=>{
 const pg=new PGlite();
 try{
 await pg.exec('create role anon; create role authenticated; create role service_role;');
 await pg.exec(await fs.readFile(new URL('../migrations/20261007_kitchen_invoices.sql',import.meta.url),'utf8'));
 const d={id:'x',clientId:'demo-kitchen',supplierRut:'11111111-1',documentType:'factura',folio:'001',lines:[]};
 const r=buildRecord(d);await pg.query('select save_kitchen_invoice($1::jsonb,0)',[JSON.stringify(r)]);
 r.version=2;await pg.query('select save_kitchen_invoice($1::jsonb,1)',[JSON.stringify(r)]);
 await assert.rejects(()=>pg.query('select save_kitchen_invoice($1::jsonb,1)',[JSON.stringify(r)]),/Concurrent/);
 const duplicate=buildRecord(d);await assert.rejects(()=>pg.query('select save_kitchen_invoice($1::jsonb,0)',[JSON.stringify(duplicate)]),/unique/);
 assert.equal((await pg.query('select count(*)::integer as count from kitchen_invoices')).rows[0].count,1);
 await pg.exec('set role anon');await assert.rejects(()=>pg.query('select * from kitchen_invoices'),/permission denied/);await pg.exec('reset role');
 assert.equal((await pg.query("select count(*)::integer as count from pg_tables where tablename='cms_store'")).rows[0].count,0);
 }finally{await pg.close();}
});
