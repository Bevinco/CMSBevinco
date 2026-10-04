import test from "node:test";
import assert from "node:assert/strict";
import { convertNetLine, normalizePurchaseCost, mappingKey, suggestProducts, priceIncrease, validateInvoice } from "../server/invoicing/domain.js";

test("meat packs convert to kilos; desserts remain per piece even when weight is known", () => {
  const meat = normalizePurchaseCost({ quantity: 8, netLineTotal: 180000, purchaseUnit: "unit", costBasis: "kg", unitsPerPurchaseUnit: 1, contentPerUnit: { value: 4500, unit: "g" } });
  assert.equal(meat.baseQuantity, 36);
  assert.equal(meat.netCostPerBaseUnit, 5000);
  const dessert = normalizePurchaseCost({ quantity: 2, netLineTotal: 112000, purchaseUnit: "case", costBasis: "unit", unitsPerPurchaseUnit: 28, contentPerUnit: { value: 150, unit: "g" } });
  assert.equal(dessert.baseQuantity, 56);
  assert.equal(dessert.netCostPerBaseUnit, 2000);
});

test("actual purchased weight overrides nominal pack weight without applying yield", () => {
  const result = normalizePurchaseCost({ quantity: 2, netLineTotal: 95000, purchaseUnit: "case", costBasis: "kg", unitsPerPurchaseUnit: 1, contentPerUnit: { value: 5, unit: "kg" }, measuredTotalKg: 9.5 });
  assert.equal(result.baseQuantity, 9.5);
  assert.equal(result.netCostPerBaseUnit, 10000);
});

test("weight, volume and piece counts cannot be silently interchanged", () => {
  assert.equal(normalizePurchaseCost({ quantity: 500, netLineTotal: 2500, purchaseUnit: "g", costBasis: "kg" }).netCostPerBaseUnit, 5000);
  assert.equal(normalizePurchaseCost({ quantity: 2, netLineTotal: 60000, purchaseUnit: "unit", costBasis: "L", unitsPerPurchaseUnit: 1, contentPerUnit: { value: 10000, unit: "ml" } }).netCostPerBaseUnit, 3000);
  for (const override of [
    { purchaseUnit: "case", costBasis: "unit" },
    { purchaseUnit: "kg", costBasis: "unit" },
    { purchaseUnit: "unit", costBasis: "kg", unitsPerPurchaseUnit: 1, contentPerUnit: { value: 10, unit: "L" } },
    { purchaseUnit: "unit", costBasis: "kg", unitsPerPurchaseUnit: 1, contentPerUnit: { value: 0, unit: "g" } },
    { purchaseUnit: "unknown", costBasis: "kg" },
  ]) assert.throws(() => normalizePurchaseCost({ quantity: 1, netLineTotal: 1000, ...override }));
});

test("converting a purchase pack preserves its net total and uses documented precision", () => {
  assert.deepEqual(convertNetLine({ quantity: 4, netLineTotal: 120000, targetUnitsPerSourceUnit: 10 }), {
    targetQuantity: 40, targetNetUnitPrice: 3000, netLineTotal: 120000,
  });
  const result = convertNetLine({ quantity: 3, netLineTotal: 10, targetUnitsPerSourceUnit: 1000 });
  assert.equal(result.targetQuantity * result.targetNetUnitPrice, 10);
  for (const factor of [0, -1, NaN, Infinity, "24"]) {
    assert.throws(() => convertNetLine({ quantity: 1, netLineTotal: 100, targetUnitsPerSourceUnit: factor }));
  }
});

const context = { clientId: "synthetic-kitchen", supplierId: "supplier-a", sourceProduct: "Atún Lomo", sourcePresentation: "Caja 24" };
const catalog = [
  { clientId: context.clientId, productId: "p1", presentationId: "s1", name: "Atun" },
  { clientId: "other-client", productId: "p2", presentationId: "s2", name: "Atún Lomo" },
];

test("learned mappings never leak across clients, suppliers or pack sizes", () => {
  const mappings = [{ key: mappingKey(context), productId: "p1", presentationId: "s1", factor: 24, reviewed: true }];
  const suggest = (overrides = {}) => suggestProducts({ ...context, catalog, mappings, ...overrides });
  assert.equal(suggest()[0].factor, 24);
  assert.equal(suggest()[0].requiresReview, true);
  for (const overrides of [{ supplierId: "supplier-b" }, { sourcePresentation: "Caja 12" }, { clientId: "other-client" }]) {
    assert.ok(suggest(overrides).every((item) => item.reason !== "learned"));
  }
  assert.ok(suggest().every((item) => item.clientId === context.clientId));
  assert.ok(suggest({ catalog: [] }).length === 0);
});

test("unit mismatch and absent baseline do not create misleading price alerts", () => {
  const base = { currentNetCost: 120, previousNetCost: 100, currentUnit: "kg", previousUnit: "kg", thresholdPercent: 10 };
  assert.equal(priceIncrease(base).alert, true);
  assert.equal(priceIncrease({ ...base, currentNetCost: 110 }).alert, false);
  assert.equal(priceIncrease({ ...base, previousUnit: "g" }), null);
  assert.equal(priceIncrease({ ...base, previousNetCost: 0 }), null);
});

const invoice = () => ({
  area: "kitchen", priceBasis: "net", clientId: "synthetic-kitchen", supplierId: "supplier-a", folio: "00001", date: "2026-01-01",
  net: 1000, vat: 190, total: 1190, reviewed: true,
  lines: [{ quantity: 2, netLineTotal: 1000, targetUnitsPerSourceUnit: 1, purchaseUnit: "kg", costBasis: "kg", productId: "p1", presentationId: "s1", reviewed: true }],
});

test("review and net basis are mandatory; tax never changes a product cost", () => {
  const valid = invoice();
  assert.equal(validateInvoice(valid).canConfirm, true);
  assert.equal(convertNetLine(valid.lines[0]).targetNetUnitPrice, 500);
  for (const changes of [{ area: "bar" }, { priceBasis: "gross" }, { reviewed: false }, { net: 900 }, { total: 1000 }, { vat: null }]) {
    assert.equal(validateInvoice({ ...valid, ...changes }).canConfirm, false);
  }
  valid.lines[0].reviewed = false;
  assert.equal(validateInvoice(valid).canConfirm, false);
  const missingBasis = invoice();
  delete missingBasis.lines[0].costBasis;
  assert.equal(validateInvoice(missingBasis).canConfirm, false);
});

test("exempt or exceptional VAT requires explicit review and balanced totals", () => {
  const exempt = { ...invoice(), vat: 0, total: 1000 };
  assert.equal(validateInvoice(exempt).canConfirm, false);
  assert.equal(validateInvoice({ ...exempt, taxExceptionReviewed: true }).canConfirm, true);
  assert.equal(validateInvoice({ ...exempt, total: 9990, taxExceptionReviewed: true }).canConfirm, false);
});
