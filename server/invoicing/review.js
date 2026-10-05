import { normalizePurchaseCost, normalizeLabel } from './domain.js';

// Review drafts are deliberately separate from confirmed invoices and SH imports.
export function duplicateKey(draft) {
  const supplier = normalizeLabel(draft.supplierRut).replace(/[^0-9k]/g, '');
  if (!draft.clientId || !supplier || !draft.folio.trim()) return null;
  return JSON.stringify([draft.clientId, supplier, draft.documentType, draft.folio.trim()]);
}

export function reviewDraft(draft, previous = []) {
  const errors = [];
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!draft.supplier.trim() || !duplicateKey(draft)) errors.push('Completa proveedor, RUT y folio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !Number.isFinite(Date.parse(draft.date)) || new Date(draft.date).toISOString().slice(0, 10) !== draft.date) errors.push('Completa una fecha válida.');
  if (previous.some(item => item.id !== draft.id && duplicateKey(item) === duplicateKey(draft) && duplicateKey(draft))) errors.push('Posible duplicado: mismo cliente, RUT, tipo de documento y folio en esta sesión.');
  if (!draft.lines.length) errors.push('Agrega al menos una línea.');
  const results = draft.lines.map((line, index) => {
    const issues = [];
    let cost = null;
    if (!line.description.trim()) issues.push('Falta producto.');
    if (!amount(line.netLineTotal)) issues.push('Falta importe neto.');
    if (line.kind === 'food') {
      try { cost = normalizePurchaseCost(line); } catch (error) { issues.push(error.message); }
      if (!line.reviewed) issues.push('Formato pendiente de confirmar.');
    } else if (!['delivery', 'supply'].includes(line.kind)) issues.push('Clasificación inválida.');
    else if (!line.note.trim()) issues.push('Indica cómo tratar este cargo o insumo; no se exporta a SH en esta prueba.');
    if (line.note.trim() && line.kind === 'food' && !line.reviewed) issues.push(`Pendiente: ${line.note}`);
    issues.forEach(issue => errors.push(`Línea ${index + 1}: ${issue}`));
    return { issues, cost };
  });
  const sum = draft.lines.reduce((total, line) => total + (amount(line.netLineTotal) ? line.netLineTotal : 0), 0);
  for (const key of ['net', 'vat', 'otherTaxes', 'total']) if (!amount(draft[key])) errors.push(`Completa ${ {net:'neto',vat:'IVA',otherTaxes:'otros impuestos',total:'total'}[key] } con un monto válido.`);
  if (amount(draft.net) && Math.abs(sum - draft.net) > 1) errors.push('La suma de líneas no coincide con el neto documental.');
  if (['net','vat','otherTaxes','total'].every(key => amount(draft[key])) && Math.abs(draft.net + draft.vat + draft.otherTaxes - draft.total) > 1) errors.push('Neto + IVA + otros impuestos no coincide con el total.');
  if (amount(draft.net) && amount(draft.vat) && Math.abs(draft.net * .19 - draft.vat) > 1 && !draft.taxExceptionReviewed) errors.push('Revisa y confirma el tratamiento de IVA distinto del 19%.');
  return { errors, results, sum, readyForMapping: errors.length === 0 };
}

export function parseReviewFile(text) {
  const payload = JSON.parse(text);
  const d = payload?.invoice;
  const str = v => typeof v === 'string' && v.length <= 2000;
  const num = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (payload?.version !== 1 || payload?.status !== 'draft' || !d || !['28922','demo-kitchen'].includes(d.clientId)) throw new Error('El archivo no es un borrador compatible de este piloto.');
  for (const key of ['id','clientId','supplier','supplierRut','documentType','folio','date']) if (!str(d[key])) throw new Error('Encabezado inválido.');
  if (d.documentType !== 'factura' || typeof d.taxExceptionReviewed !== 'boolean') throw new Error('Tipo de documento inválido.');
  for (const key of ['net','vat','otherTaxes','total']) if (!num(d[key])) throw new Error('Importes inválidos.');
  if (!Array.isArray(d.lines) || d.lines.length > 500) throw new Error('Líneas inválidas (máximo 500).');
  for (const l of d.lines) {
    if (!l || !['food','delivery','supply'].includes(l.kind) || typeof l.reviewed !== 'boolean') throw new Error('Línea inválida.');
    for (const key of ['id','description','purchaseUnit','costBasis','note']) if (!str(l[key])) throw new Error('Texto de línea inválido.');
    for (const key of ['quantity','netLineTotal','unitsPerPurchaseUnit','measuredTotalKg']) if (!num(l[key])) throw new Error('Cantidad inválida.');
    if (!l.contentPerUnit || !num(l.contentPerUnit.value) || !str(l.contentPerUnit.unit)) throw new Error('Contenido inválido.');
  }
  if (new Set(d.lines.map(l => l.id)).size !== d.lines.length) throw new Error('Identificadores de línea duplicados.');
  return d;
}
