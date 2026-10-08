// Navigation is a read-only view. Dates never assign an invoice to an SH period.
export function invoicePeriod(invoice) {
  const value = invoice.existingInSh?.period;
  return value == null || String(value).trim() === '' ? 'unassigned' : String(value);
}
export function buildPeriodOptions(invoices, knownPeriods = []) {
  const periods = new Map();
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : '';
  for (const period of knownPeriods) {
    const id = String(period.id || '');
    if (!/^\d+$/.test(id)) continue;
    const start = date(period.startsAt), end = date(period.endsAt);
    periods.set(id, {id, label: `Período ${id}${start && end ? ` · ${start} – ${end}` : ''}`});
  }
  for (const invoice of invoices) {
    const id = invoicePeriod(invoice);
    if (id !== 'unassigned' && !periods.has(id)) periods.set(id, {id, label: `Período ${id} · fechas por actualizar`});
  }
  return [...periods.values()].sort((a,b) => b.id.localeCompare(a.id, 'es', {numeric:true}))
    .concat({id:'unassigned',label:'Sin período asignado'});
}
