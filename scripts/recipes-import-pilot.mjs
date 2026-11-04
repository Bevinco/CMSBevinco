// Convert a private, previously reconciled pilot export; never commit its output.
import fs from "node:fs";
import { evaluateRecipes } from "../server/recipes/costing.js";

export function importPilot(pilot, rawCosts) {
  const scope = { clientId: String(pilot.client_id), account: pilot.account, area: pilot.area };
  const nodes = new Map(pilot.nodes.map(node => [node.id, node]));
  const costs = new Map(rawCosts.map(cost => [cost.id, cost]));
  const allLines = [...pilot.nodes.flatMap(node => node.lines || []), ...pilot.cards.flatMap(card => [...card.lines, ...card.variants.flatMap(variant => variant.lines || [])]), ...pilot.sides.flatMap(side => side.lines)];
  const lines = (entries) => entries.map(line => ({ itemId: line.id, quantity: line.quantity, unit: line.unit }));
  const materialIds = new Set(allLines.filter(line => !nodes.has(line.id)).map(line => line.id));
  for (const node of pilot.nodes) if (node.kind === "yield") materialIds.add(node.raw_id);

  function pack(description) {
    const match = String(description).match(/\(([\d.]+)\s*(?:[xX]\s*([\d.]+)\s*)?(kg|g|ml|L)\b/);
    if (!match) throw new Error("Formato de materia prima sin equivalencia explícita; completar importación.");
    return { quantity: Number(match[1]) * Number(match[2] || 1) * (["kg", "L"].includes(match[3]) ? 1000 : 1), unit: ["kg", "g"].includes(match[3]) ? "g" : "ml" };
  }

  const items = [...materialIds].map(id => {
    const references = allLines.filter(line => line.id === id);
    const priced = references.find(line => line.unit_cost !== null && !line.issues.length);
    const raw = costs.get(id);
    let unit = priced?.unit || references[0]?.unit;
    let unitCost = priced?.unit_cost;
    let source = priced?.source;
    if (!priced && raw?.price?.price !== "" && raw?.price?.price != null) {
      const format = pack(raw.description);
      unit = format.unit;
      unitCost = Number(raw.price.price) / format.quantity;
      const invoice = raw.own_invoice_history.find(invoice => String(invoice.clientid) === scope.clientId && Number(invoice.price) === Number(raw.price.price));
      source = invoice ? `SH: factura ${invoice.invoice_number}, ${invoice.invoice_date}` : "Último costo registrado SH observado en la lectura; factura propia coincidente no localizada";
    }
    if (!unit) throw new Error("Producto sin unidad de costo identificada.");
    let conversion = pilot.confirmed_conversions[id];
    // Values already reconciled in recipe units keep that basis. Raw mass/volume
    // equivalences are carried only for this product, never globally inferred.
    if (conversion) conversion = { gramsPerMl: conversion.g_per_ml, authority: conversion.authority };
    const origin = /estimad/i.test(source || "") ? "estimate" : /manual/i.test(source || "") ? "manual" : /factura/i.test(source || "") && !/no localizada|sin factura/i.test(source || "") ? "invoice" : "recorded";
    return { id, name: priced?.name || references[0]?.name || raw?.name || `Materia prima ${id}`, kind: "material", unit, scope, ...(conversion ? { conversion } : {}), prices: unitCost == null || unitCost <= 0 ? [] : [{ unitCost, enteredAt: pilot.read_at, source, origin, scope }] };
  });
  for (const node of pilot.nodes) {
    items.push(node.kind === "yield" ? { id: node.id, name: node.name, kind: "yield", unit: node.unit, rawId: node.raw_id, yieldRatio: node.yield_percent / 100, scope } : { id: node.id, name: node.name, kind: "preparation", unit: node.unit, outputQuantity: node.output, lines: lines(node.lines), scope });
  }
  for (const side of pilot.sides) items.push({ id: side.id, name: side.name.replace(/\s*\(\*Extra\)/, ""), kind: "preparation", unit: "un", outputQuantity: 1, lines: lines(side.lines), scope });
  const bundle = {
    schemaVersion: 1, scope, clientName: "Piloto de cocina", sourceReadAt: pilot.read_at,
    salesPeriod: pilot.sales_period.label, items,
    recipes: pilot.cards.map(card => ({ id: card.id, name: card.name, portions: 1, lines: lines(card.lines), notes: card.notes, sides: card.weighted_cost != null ? pilot.sides.map(side => ({ itemId: side.id, count: side.sales_count })) : [], options: card.variants.filter(variant => variant.lines).map(variant => ({ name: variant.name, lines: lines(variant.lines) })) })),
  };
  const evaluation = evaluateRecipes(bundle);
  const mismatches = evaluation.recipes.filter(recipe => {
    const old = pilot.cards.find(card => card.id === recipe.id);
    return (old.base_cost === null) !== (recipe.baseCost === null) || old.base_cost !== null && Math.abs(old.base_cost - recipe.baseCost) > 0.000001 || Math.abs(old.partial_cost - recipe.knownCost) > 0.000001 || old.weighted_cost !== null && Math.abs(old.weighted_cost - recipe.totalCost) > 0.000001 || recipe.options.some(option => Math.abs(option.cost - old.variants.find(v => v.name === option.name).cost) > 0.000001);
  });
  if (mismatches.length) throw new Error(`La importación no reproduce ${mismatches.length} costos del piloto conciliado.`);
  return bundle;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const [, , pilotPath, costsPath, outputPath] = process.argv;
  if (!pilotPath || !costsPath || !outputPath) throw new Error("Uso: node scripts/recipes-import-pilot.mjs piloto.json costos.json salida-privada.json");
  const bundle = importPilot(JSON.parse(fs.readFileSync(pilotPath)), JSON.parse(fs.readFileSync(costsPath)));
  fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ recipes: bundle.recipes.length, ...evaluateRecipes(bundle).counts, note: "Fecha de referencia de costos = lectura del piloto; no se inventan fechas de ingreso SH ni ventas nuevas." }));
}
