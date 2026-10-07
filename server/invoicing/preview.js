// Isolated review server. No production store, accounts, mail, or SH writes.
import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localRepository} from './storage.js';
import {invoiceRouter} from './router.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=express();const port=Number(process.env.INVOICE_PREVIEW_PORT||4317);
app.use((req,res,next)=>{if(!['127.0.0.1','localhost'].includes(req.hostname))return res.status(403).end();next();});
app.use(express.json({limit:'15mb'}));
app.use('/api/invoicing',(req,_res,next)=>{req.session={username:'local-review',role:'Superadmin'};next();},invoiceRouter({repository:localRepository(process.env.INVOICE_LOCAL_DB||path.join(root,'data/invoicing/review.sqlite')),clients:[{id:'28922',name:'El Muelle Cocina'},{id:'demo-kitchen',name:'Ejemplo ficticio'}],apiKey:process.env.OPENAI_API_KEY,model:process.env.INVOICE_OPENAI_MODEL}));
app.use(express.static(path.join(root,'dist-review')));
app.get('/',(_req,res)=>res.redirect('/revision-facturas.html'));
app.listen(port,'127.0.0.1',()=>console.log(`Invoice review http://127.0.0.1:${port}/revision-facturas.html`));
