import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDraft, duplicateKey, parseReviewFile } from '../server/invoicing/review.js';
const fixture = () => ({id:'a',clientId:'28922',supplier:'Synthetic',supplierRut:'11.111.111-1',documentType:'factura',folio:'0001',date:'2026-01-01',net:1000,vat:190,otherTaxes:50,total:1240,taxExceptionReviewed:false,lines:[{id:'l',description:'Meat',kind:'food',quantity:2,netLineTotal:1000,purchaseUnit:'kg',costBasis:'kg',unitsPerPurchaseUnit:null,contentPerUnit:{value:null,unit:'g'},measuredTotalKg:null,reviewed:true,note:''}]});
test('documentary other taxes balance but do not inflate food costs',()=>{
 const d=fixture();assert.equal(reviewDraft(d).readyForMapping,true);assert.equal(reviewDraft(d).results[0].cost.netCostPerBaseUnit,500);
 assert.equal(reviewDraft({...d,total:1190}).readyForMapping,false);
 assert.equal(reviewDraft({...d,vat:null}).readyForMapping,false);
});
test('duplicates are scoped to client, tax ID, document type and literal folio',()=>{
 const d=fixture(); const other={...d,id:'b',supplierRut:'11111111-1'};
 assert.equal(duplicateKey(d),duplicateKey(other));assert.match(reviewDraft(d,[other]).errors.join(' '),/duplicado/);
 assert.equal(reviewDraft(d,[d]).readyForMapping,true);
 assert.equal(reviewDraft({...d,clientId:'other'},[other]).readyForMapping,true);
 assert.equal(reviewDraft({...d,folio:'001'},[other]).readyForMapping,true);
});
test('pending formats, liter-to-kilo assumptions, invalid dates and untreated delivery block readiness',()=>{
 const d=fixture();d.lines[0].reviewed=false;assert.equal(reviewDraft(d).readyForMapping,false);
 d.lines[0].reviewed=true;d.lines[0].purchaseUnit='L';assert.equal(reviewDraft(d).results[0].cost,null);
 assert.equal(reviewDraft({...fixture(),date:'2026-02-30'}).readyForMapping,false);
 d.lines[0].kind='delivery';assert.equal(reviewDraft(d).readyForMapping,false);d.lines[0].note='Excluded from SH';assert.equal(reviewDraft(d).readyForMapping,true);
});
test('draft recovery preserves blanks, rejects other clients and malformed or duplicate lines',()=>{
 const d=fixture();const encode=invoice=>JSON.stringify({version:1,status:'draft',invoice});
 assert.deepEqual(parseReviewFile(encode(d)),d);
 assert.throws(()=>parseReviewFile(encode({...d,clientId:'other'})));
 assert.throws(()=>parseReviewFile(encode({...d,lines:[{}]})));
 assert.throws(()=>parseReviewFile(encode({...d,lines:[...d.lines,...d.lines]})));
 assert.throws(()=>parseReviewFile(encode({...d,total:'1240'})));
});
