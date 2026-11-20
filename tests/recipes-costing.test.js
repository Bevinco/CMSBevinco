import test from "node:test";
import assert from "node:assert/strict";
import { convertQuantity, evaluateRecipes } from "../server/recipes/costing.js";
import { evaluateActualSale } from "../server/recipes/sales.js";
const scope = { clientId: "synthetic-food", account: "account-a", area: "Food" };
const price = (unitCost, enteredAt = "2026-01-01T10:00:00Z", other = {}) => ({ unitCost, enteredAt, scope, source: "Factura de prueba", origin: "invoice", ...other });
const material = (id = "raw", other = {}) => ({ id, name: id, kind: "material", unit: "g", scope, prices: [price(10)], ...other });
const line = (itemId = "raw", quantity = 200, unit = "g") => ({ itemId, quantity, unit });
const recipe = (id = "plate", other = {}) => ({ id, name: id, portions: 1, lines: [line()], sides: [], options: [], ...other });
const bundle = (other = {}) => ({ schemaVersion: 1, scope, sourceReadAt: "2026-02-01T00:00:00Z", salesPeriod: "Período de prueba", items: [material()], recipes: [recipe()], ...other });
const first = data => evaluateRecipes(data).recipes[0];

test("latest entered own price replaces older prices without averaging or reading future values", () => {
  const data = bundle({ items: [material("raw", { prices: [price(12, "2026-01-20T10:00:00Z"), price(100, "2026-02-02T00:00:00Z"), price(10)] })] });
  assert.equal(first(data).baseCost, 2400);
  assert.equal(first(data).lines[0].priceDate, "2026-01-20T10:00:00Z");
});
test("a missing cost affects only dependent dishes and cannot become zero", () => {
  const data = bundle({ items: [material(), material("missing", { prices: [] })], recipes: [recipe("incomplete", { lines: [line(), line("missing", 5)] }), recipe("ready")] });
  const result = evaluateRecipes(data);
  assert.equal(result.recipes[0].totalCost, null);
  assert.equal(result.recipes[0].knownCost, 2000);
  assert.equal(result.recipes[1].totalCost, 2000);
  assert.equal(result.counts.pending, 1);
});
test("grams and ml require ingredient-specific backed conversion", () => {
  assert.throws(() => convertQuantity(20, "g", "ml"));
  assert.equal(convertQuantity(20, "g", "ml", { gramsPerMl: 2, authority: "Medición chef" }), 10);
  assert.equal(convertQuantity(8, "ml", "g", { gramsPerMl: 1, authority: "Confirmado para esta mostaza" }), 8);
  const r = first(bundle({ recipes: [recipe("plate", { lines: [line("raw", 20, "ml")] })] }));
  assert.equal(r.totalCost, null);
});
test("yield is applied once through a preparation; rice may gain weight", () => {
  const items = [material(), { id: "clean", name: "clean", kind: "yield", unit: "g", rawId: "raw", yieldRatio: 0.6, scope }, { id: "prep", name: "prep", kind: "preparation", unit: "g", outputQuantity: 30, lines: [line("clean", 30)], scope }];
  assert.ok(Math.abs(first(bundle({ items, recipes: [recipe("plate", { lines: [line("prep", 30)] })] })).totalCost - 500) < 1e-8);
  items[1].yieldRatio = 3;
  assert.ok(Math.abs(first(bundle({ items, recipes: [recipe("plate", { lines: [line("clean", 300)] })] })).totalCost - 1000) < 1e-8);
});
test("yield on already yielded or prepared stock is held instead of doubled", () => {
  const items = [material(), { id: "clean", name: "clean", kind: "yield", unit: "g", rawId: "raw", yieldRatio: 0.6, scope }, { id: "double", name: "double", kind: "yield", unit: "g", rawId: "clean", yieldRatio: 0.6, scope }];
  assert.equal(first(bundle({ items, recipes: [recipe("plate", { lines: [line("double", 30)] })] })).totalCost, null);
});
test("preparation with missing ingredient retains known subtotal, cycles cannot hang", () => {
  const prep = { id: "prep", name: "prep", kind: "preparation", unit: "g", outputQuantity: 1000, lines: [line("raw", 500), line("unknown", 500)], scope };
  let result = first(bundle({ items: [material(), prep], recipes: [recipe("plate", { lines: [line("prep", 100)] })] }));
  assert.equal(result.totalCost, null); assert.equal(result.knownCost, 500);
  prep.lines = [line("prep", 1)];
  result = first(bundle({ items: [material(), prep], recipes: [recipe("plate", { lines: [line("prep", 100)] })] }));
  assert.match(result.issues.join(" "), /circular/);
});
test("side dish weights use all eligible counts and do not add alternatives together", () => {
  const items = [material(), material("potatoes", { unit: "un", prices: [price(430)] }), material("rice", { unit: "un", prices: [price(170)] }), material("salad", { unit: "un", prices: [price(736)] })];
  const data = bundle({ items, recipes: [recipe("main", { sides: [{ itemId: "potatoes", count: 57 }, { itemId: "rice", count: 23 }, { itemId: "salad", count: 30 }] })] });
  const r = first(data);
  assert.ok(Math.abs(r.weightedSideCost - (430 * 57 + 170 * 23 + 736 * 30) / 110) < 1e-8);
  assert.equal(r.totalCost, 2000 + r.weightedSideCost);
  assert.equal(r.sides[0].combinedCost, 2430);
  data.recipes[0].sides.forEach(side => side.count = 0);
  assert.equal(first(data).totalCost, null);
});
test("paid extras and alternate toppings are separate from main recipe cost", () => {
  const data = bundle({ items: [material(), material("topping", { prices: [price(5)] })], recipes: [recipe("waffle", { options: [{ name: "Option A", lines: [line("topping", 60)] }, { name: "Option B", lines: [line("topping", 100)] }] }), recipe("extra", { lines: [line("topping", 30)] })] });
  const r = evaluateRecipes(data);
  assert.equal(r.recipes[0].totalCost, 2000);
  assert.deepEqual(r.recipes[0].options.map(x => x.cost), [2300, 2500]);
  assert.equal(r.recipes[1].totalCost, 150);
});
test("manual costs are usable; authorized estimates stay visibly provisional", () => {
  const data = bundle({ items: [material("raw", { prices: [price(10, undefined, { origin: "estimate", source: "Estimación autorizada" })] })] });
  assert.equal(first(data).totalCost, 2000);
  assert.equal(first(data).status, "provisional");
});
test("foreign clients, accounts and areas cannot contribute any price or ingredient", () => {
  for (const otherScope of [{ ...scope, clientId: "foreign" }, { ...scope, account: "other" }, { ...scope, area: "Beverage" }]) {
    assert.throws(() => evaluateRecipes(bundle({ items: [material("raw", { scope: otherScope })] })));
    assert.throws(() => evaluateRecipes(bundle({ items: [material("raw", { prices: [price(10, undefined, { scope: otherScope })] })] })));
  }
});
test("unreviewed zero, nonfinite values, bad units and duplicated ids do not yield totals", () => {
  for (const value of [0, -1, NaN, Infinity, "10"]) assert.throws(() => evaluateRecipes(bundle({ items: [material("raw", { prices: [price(value)] })] })));
  assert.throws(() => evaluateRecipes(bundle({ items: [material(), material()] })));
  assert.throws(() => evaluateRecipes(bundle({ recipes: [recipe("bad", { portions: 0 })] })));
  assert.throws(() => evaluateRecipes(bundle({ recipes: [recipe("bad", { lines: [line("raw", 20, "unknown")] })] })));
});
test("margins need a sourced net sales price and complete cost", () => {
  assert.equal(first(bundle()).ingredientCostPercent, null);
  const r = first(bundle({ recipes: [recipe("plate", { saleNet: 10000, saleSource: "Carta neta aprobada" })] }));
  assert.equal(r.ingredientCostPercent, 20); assert.equal(r.contribution, 8000);
  assert.throws(() => evaluateRecipes(bundle({ recipes: [recipe("plate", { saleNet: 10000 })] })));
});
test("same-time contradictory costs require reconciliation instead of arbitrary selection", () => {
  assert.equal(first(bundle({ items: [material("raw", { prices: [price(10), price(12)] })] })).totalCost, null);
  assert.equal(first(bundle({ items: [material("raw", { prices: [price(10), price(12, "2026-01-01T07:00:00-03:00")] })] })).totalCost, null);
});

const toteat = (rows) => ({ source: "Toteat", startDate: "2026-01-11", endDate: "2026-01-17", rows });
const actualRow = (other = {}) => ({ recipeId: "plate", units: 5, netRevenue: 30000, productCodes: ["sku-1"], ...other });

test("actual margin uses period net revenue and complete ingredient cost", () => {
  const row = actualRow();
  const dish = first(bundle({ actualSales: toteat([row]) }));
  const sale = evaluateActualSale(row, dish);
  assert.equal(sale.netPerUnit, 6000);
  assert.equal(sale.ingredientCost, 10000);
  assert.equal(sale.contribution, 20000);
  assert.ok(Math.abs(sale.marginPercent - 200 / 3) < 1e-10);

  const incomplete = first(bundle({ items: [material("raw", { prices: [] })] }));
  assert.equal(evaluateActualSale(row, incomplete).contribution, null);
  assert.equal(evaluateActualSale(row, incomplete).netRevenue, 30000);
  assert.equal(evaluateActualSale(undefined, dish), null);

  const free = evaluateActualSale(actualRow({ netRevenue: 0 }), dish);
  assert.equal(free.contribution, -10000);
  assert.equal(free.marginPercent, null);
  const inactive = evaluateActualSale(actualRow({ units: 0, netRevenue: 0 }), dish);
  assert.equal(inactive.hasSales, false);
});

test("actual margin requires a complete mix of sold options and counts included sides once", () => {
  const variable = recipe("plate", {
    sides: [{ itemId: "side", count: 5 }],
    options: [{ name: "Option A", lines: [line("raw", 10)] }, { name: "Option B", lines: [line("raw", 20)] }],
  });
  const items = [material(), material("side", { unit: "un", prices: [price(500)] })];
  const row = actualRow({ options: [{ name: "Option A", units: 2 }, { name: "Option B", units: 3 }] });
  const data = bundle({ items, recipes: [variable], actualSales: toteat([row]) });
  const dish = first(data);
  assert.equal(evaluateActualSale(row, dish).ingredientCost, 13300);
  assert.equal(evaluateActualSale(actualRow(), dish).ingredientCost, null);
  assert.throws(() => first({ ...data, actualSales: toteat([actualRow({ options: [{ name: "Option A", units: 4 }] })]) }), /todas las unidades/);
});

test("actual sales reject dates that roll over, orphan recipes and double-counted codes", () => {
  assert.throws(() => first(bundle({ actualSales: { ...toteat([]), startDate: "2025-02-29" } })), /período/);
  assert.throws(() => first(bundle({ actualSales: toteat([actualRow({ recipeId: "wrong" })]) })), /sin receta/);
  assert.throws(() => first(bundle({
    recipes: [recipe(), recipe("other")],
    actualSales: toteat([actualRow(), actualRow({ recipeId: "other" })]),
  })), /más de una receta/);
});
