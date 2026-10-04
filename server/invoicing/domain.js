// Kitchen invoices only. All monetary inputs below are NET of VAT.
// This module does not persist data, approve suggestions, or write to Sculpture.
export function normalizeLabel(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function positive(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} debe ser un número mayor que cero.`);
  }
  return value;
}

function nonnegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} debe ser un número no negativo.`);
  }
  return value;
}

// Factor is explicitly approved purchase-format conversion, never cooking yield.
// Preserve documented line total: unit prices printed on invoices may be rounded.
export function convertNetLine({ quantity, netLineTotal, targetUnitsPerSourceUnit }) {
  positive(quantity, "Cantidad");
  nonnegative(netLineTotal, "Importe neto");
  positive(targetUnitsPerSourceUnit, "Factor de conversión");
  const targetQuantity = positive(quantity * targetUnitsPerSourceUnit, "Cantidad convertida");
  const targetNetUnitPrice = nonnegative(netLineTotal / targetQuantity, "Precio convertido");
  return { targetQuantity, targetNetUnitPrice, netLineTotal };
}

// A learned rule applies only to this client, supplier AND original presentation.
// The caller must resolve supplierId from the supplier registered in SH first.
export function mappingKey({ clientId, supplierId, sourceProduct, sourcePresentation }) {
  const parts = [clientId, supplierId, normalizeLabel(sourceProduct), normalizeLabel(sourcePresentation)];
  if (parts.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error("Faltan cliente, proveedor, producto o formato para buscar una equivalencia.");
  }
  return JSON.stringify(parts);
}

export function suggestProducts({ clientId, supplierId, sourceProduct, sourcePresentation, catalog, mappings }) {
  const key = mappingKey({ clientId, supplierId, sourceProduct, sourcePresentation });
  const available = catalog.filter((item) => item.clientId === clientId && item.active !== false);
  const learned = mappings.find((rule) => rule.key === key && rule.reviewed === true);
  if (learned) {
    const item = available.find((entry) => entry.productId === learned.productId && entry.presentationId === learned.presentationId);
    if (item && typeof learned.factor === "number" && Number.isFinite(learned.factor) && learned.factor > 0) {
      return [{ ...item, reason: "learned", factor: learned.factor, requiresReview: true }];
    }
  }
  const name = normalizeLabel(sourceProduct);
  const words = new Set(name.split(" "));
  return available.map((item) => {
    const candidate = normalizeLabel(item.name);
    const tokens = new Set(candidate.split(" "));
    const intersection = [...words].filter((word) => tokens.has(word)).length;
    const score = intersection / new Set([...words, ...tokens]).size;
    return { ...item, score, reason: candidate === name ? "exact-name" : "similar-name", requiresReview: true };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
}

// Compare like-for-like normalized units and net costs only. Missing or zero
// baseline is not evidence of stable pricing, so return null rather than 0%.
export function priceIncrease({ currentNetCost, previousNetCost, currentUnit, previousUnit, thresholdPercent }) {
  nonnegative(currentNetCost, "Costo neto actual");
  nonnegative(thresholdPercent, "Umbral de alza");
  if (typeof previousNetCost !== "number" || !Number.isFinite(previousNetCost) || previousNetCost <= 0 || !currentUnit || currentUnit !== previousUnit) return null;
  const percent = (currentNetCost / previousNetCost - 1) * 100;
  return { percent, alert: percent > thresholdPercent + 1e-9 };
}

// Documentary VAT is checked separately and NEVER added to product costs.
// Null means unknown, not zero. Exempt/other tax treatment needs explicit review.
export function validateInvoice(invoice, { moneyTolerance = 1 } = {}) {
  nonnegative(moneyTolerance, "Tolerancia monetaria");
  const errors = [];
  const warnings = [];
  const validAmount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (invoice.area !== "kitchen") errors.push("Esta etapa solo admite facturas de cocina.");
  if (invoice.priceBasis !== "net") errors.push("Los valores deben estar expresados sin IVA.");
  if (!invoice.clientId || !invoice.supplierId || !invoice.folio || !invoice.date) errors.push("Falta identificar cliente, proveedor, folio o fecha.");
  if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) errors.push("La factura no tiene líneas.");
  for (const [index, line] of (Array.isArray(invoice.lines) ? invoice.lines : []).entries()) {
    try {
      convertNetLine(line);
    } catch (error) {
      errors.push(`Línea ${index + 1}: ${error.message}`);
    }
    if (!line.productId || !line.presentationId || line.reviewed !== true) errors.push(`Línea ${index + 1}: confirma producto, formato y conversión.`);
  }
  for (const field of ["net", "vat", "total"]) {
    if (!validAmount(invoice[field])) errors.push(`Falta un importe válido para ${field}.`);
  }
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  if (validAmount(invoice.net) && lines.every((line) => validAmount(line.netLineTotal))) {
    const sum = lines.reduce((total, line) => total + line.netLineTotal, 0);
    if (Math.abs(sum - invoice.net) > moneyTolerance) errors.push("La suma de las líneas no coincide con el neto.");
  }
  if ([invoice.net, invoice.vat, invoice.total].every(validAmount)) {
    if (Math.abs(invoice.net + invoice.vat - invoice.total) > moneyTolerance) errors.push("Neto más IVA no coincide con el total; revisa descuentos u otros cargos.");
    if (Math.abs(invoice.net * 0.19 - invoice.vat) > moneyTolerance) {
      warnings.push("El IVA difiere del 19% del neto; revisa el tratamiento tributario.");
      if (invoice.taxExceptionReviewed !== true) errors.push("Confirma la excepción de IVA antes de guardar.");
    }
  }
  if (invoice.reviewed !== true) errors.push("La factura requiere confirmación del operador.");
  return { errors, warnings, canConfirm: errors.length === 0 };
}
