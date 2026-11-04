// Pure costing: no database, network, writes, or cross-client price fallback.
const UNITS = { g: ["mass", 1], kg: ["mass", 1000], ml: ["volume", 1], L: ["volume", 1000], un: ["count", 1] };
const validNumber = (value, positive = false) => typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0);
const scopeKey = (scope) => JSON.stringify([scope?.clientId, scope?.account, scope?.area]);
const dateValue = (value) => typeof value === "string" && /T/.test(value) ? Date.parse(value) : NaN;

export function convertQuantity(quantity, from, to, conversion) {
  if (!validNumber(quantity) || !UNITS[from] || !UNITS[to]) throw new Error("Cantidad o unidad inválida.");
  const [fromDimension, fromScale] = UNITS[from];
  const [toDimension, toScale] = UNITS[to];
  if (fromDimension === toDimension) return quantity * fromScale / toScale;
  if (!conversion?.authority?.trim() || !validNumber(conversion.gramsPerMl, true) || [fromDimension, toDimension].includes("count")) {
    throw new Error("Falta equivalencia respaldada entre masa y volumen.");
  }
  return quantity * fromScale * (fromDimension === "mass" ? 1 / conversion.gramsPerMl : conversion.gramsPerMl) / toScale;
}

export function validateBundle(bundle) {
  if (bundle?.schemaVersion !== 1 || !bundle.scope?.clientId?.trim() || !bundle.scope.account?.trim() || bundle.scope.area !== "Food") {
    throw new Error("El recetario debe identificar local, cuenta y área Cocina.");
  }
  if (!Number.isFinite(dateValue(bundle.sourceReadAt)) || !Array.isArray(bundle.items) || !Array.isArray(bundle.recipes)) {
    throw new Error("Faltan fecha de lectura, ingredientes o recetas.");
  }
  if (bundle.items.length > 10000 || bundle.recipes.length > 1000) throw new Error("El archivo supera el límite de revisión.");
  const ids = new Set();
  for (const item of bundle.items) {
    if (!item?.id?.trim() || ids.has(item.id) || !item.name?.trim() || !UNITS[item.unit]) throw new Error("Producto duplicado o sin identificación/unidad válida.");
    ids.add(item.id);
    if (scopeKey(item.scope) !== scopeKey(bundle.scope)) throw new Error("Un producto pertenece a otra cuenta, local o área.");
    if (!["material", "preparation", "yield"].includes(item.kind)) throw new Error("Tipo de producto inválido.");
    if (item.conversion && (!validNumber(item.conversion.gramsPerMl, true) || !item.conversion.authority?.trim())) throw new Error("Equivalencia sin respaldo.");
    if (item.kind === "material") {
      if (!Array.isArray(item.prices)) throw new Error("Falta información de costos del producto.");
      for (const price of item.prices) {
        if (scopeKey(price.scope) !== scopeKey(bundle.scope)) throw new Error("Costo de otro local, cuenta o área.");
        if (!validNumber(price.unitCost, true) || !Number.isFinite(dateValue(price.enteredAt)) || !price.source?.trim() || !["invoice", "recorded", "manual", "estimate"].includes(price.origin)) {
          throw new Error("Costo sin fecha, origen o importe neto positivo. Registrar costos faltantes como pendientes.");
        }
      }
    } else if (item.kind === "preparation") {
      if (!validNumber(item.outputQuantity, true) || !Array.isArray(item.lines) || !item.lines.length) throw new Error("Preparación sin salida útil o ingredientes.");
    } else if (!item.rawId?.trim() || !validNumber(item.yieldRatio, true)) throw new Error("Rendimiento sin materia prima o salida válida.");
  }
  const recipeIds = new Set();
  for (const recipe of bundle.recipes) {
    if (!recipe?.id?.trim() || recipeIds.has(recipe.id) || !recipe.name?.trim() || !validNumber(recipe.portions, true) || !Array.isArray(recipe.lines) || !recipe.lines.length) throw new Error("Receta duplicada, sin ingredientes o porciones válidas.");
    recipeIds.add(recipe.id);
    if (!Array.isArray(recipe.sides) || !Array.isArray(recipe.options)) throw new Error("Faltan opciones o guarniciones explícitas.");
    if (recipe.sides.length && !bundle.salesPeriod?.trim()) throw new Error("El promedio de guarniciones necesita un período de ventas.");
    for (const side of recipe.sides) if (!side.itemId?.trim() || !validNumber(side.count)) throw new Error("Frecuencia de guarnición inválida.");
    if (recipe.saleNet !== undefined && recipe.saleNet !== null && !validNumber(recipe.saleNet, true)) throw new Error("Precio de venta neto inválido.");
    if (recipe.saleNet != null && !recipe.saleSource?.trim()) throw new Error("Precio de venta sin fuente.");
    for (const option of recipe.options) if (!option.name?.trim() || !Array.isArray(option.lines) || !option.lines.length) throw new Error("Opción sin composición.");
  }
  const lineGroups = [...bundle.items.filter(x => x.kind === "preparation").map(x => x.lines), ...bundle.recipes.flatMap(x => [x.lines, ...x.options.map(o => o.lines)])];
  if (lineGroups.some(lines => lines.some(line => !line?.itemId?.trim() || !validNumber(line.quantity) || !UNITS[line.unit]))) throw new Error("Ingrediente con cantidad o unidad inválida.");
  return bundle;
}

export function evaluateRecipes(input) {
  const bundle = validateBundle(input);
  const items = new Map(bundle.items.map(item => [item.id, item]));
  const memo = new Map();
  const pending = (issue) => ({ cost: null, knownCost: 0, issues: [issue], provisional: false, lines: [] });

  function sumLines(lines, trail) {
    const evaluated = lines.map(line => {
      if (line.quantity === 0) return { ...line, name: items.get(line.itemId)?.name || line.itemId, cost: 0, knownCost: 0, issues: [], provisional: false };
      const item = items.get(line.itemId);
      const value = evaluateItem(line.itemId, trail);
      if (!item) return { ...line, name: line.itemId, ...value };
      try {
        const quantity = convertQuantity(line.quantity, line.unit, item.unit, item.conversion);
        return { ...line, name: item.name, source: value.source, priceDate: value.priceDate, kind: item.kind, cost: value.cost === null ? null : value.cost * quantity, knownCost: value.knownCost * quantity, issues: value.issues, provisional: value.provisional };
      } catch (error) {
        return { ...line, name: item.name, ...pending(`${item.name}: ${error.message}`) };
      }
    });
    const issues = [...new Set(evaluated.flatMap(line => line.issues))];
    return { cost: issues.length ? null : evaluated.reduce((sum, line) => sum + line.cost, 0), knownCost: evaluated.reduce((sum, line) => sum + line.knownCost, 0), issues, provisional: evaluated.some(line => line.provisional), lines: evaluated };
  }

  function evaluateItem(id, trail = []) {
    if (trail.includes(id) || trail.length >= 100) return pending("Dependencia circular o demasiado profunda en preparaciones.");
    if (memo.has(id)) return memo.get(id);
    const item = items.get(id);
    if (!item) return pending(`No se puede identificar el producto ${id}.`);
    let result;
    if (item.kind === "material") {
      const prices = item.prices.filter(price => dateValue(price.enteredAt) <= dateValue(bundle.sourceReadAt)).sort((a, b) => dateValue(b.enteredAt) - dateValue(a.enteredAt));
      const price = prices[0];
      if (!price) result = pending(`${item.name}: falta costo neto registrado o manual autorizado.`);
      else if (prices.some(other => dateValue(other.enteredAt) === dateValue(price.enteredAt) && other.unitCost !== price.unitCost)) result = pending(`${item.name}: costos contradictorios con la misma fecha; conciliar origen.`);
      else result = { cost: price.unitCost, knownCost: price.unitCost, issues: [], provisional: price.origin === "estimate", source: price.source, priceDate: price.enteredAt, lines: [] };
    } else if (item.kind === "preparation") {
      const batch = sumLines(item.lines, [...trail, id]);
      result = { ...batch, cost: batch.cost === null ? null : batch.cost / item.outputQuantity, knownCost: batch.knownCost / item.outputQuantity, source: "Costo de preparación por salida útil" };
    } else {
      const rawItem = items.get(item.rawId);
      const raw = evaluateItem(item.rawId, [...trail, id]);
      if (rawItem?.kind !== "material") result = pending(`${item.name}: el rendimiento debe partir de materia prima para evitar aplicarlo dos veces.`);
      else {
        try {
          const amount = convertQuantity(1, item.unit, rawItem.unit, rawItem.conversion) / item.yieldRatio;
          result = { ...raw, cost: raw.cost === null ? null : raw.cost * amount, knownCost: raw.knownCost * amount, source: `Rendimiento ${item.yieldRatio * 100} % aplicado una vez` };
        } catch (error) { result = pending(`${item.name}: ${error.message}`); }
      }
    }
    memo.set(id, result);
    return result;
  }

  const recipes = bundle.recipes.map(recipe => {
    const batch = sumLines(recipe.lines, []);
    const perPortion = batch.cost === null ? null : batch.cost / recipe.portions;
    const sides = recipe.sides.map(side => ({ ...side, ...evaluateItem(side.itemId), name: items.get(side.itemId)?.name || side.itemId }));
    const totalCount = sides.reduce((sum, side) => sum + side.count, 0);
    const usedSides = sides.filter(side => side.count > 0);
    const sideIssues = sides.length && totalCount === 0 ? ["Sin frecuencias válidas para ponderar guarniciones."] : usedSides.flatMap(side => side.issues);
    const weightedSide = sides.length && totalCount > 0 && !sideIssues.length ? usedSides.reduce((sum, side) => sum + side.cost * side.count / totalCount, 0) : null;
    const total = perPortion === null || sideIssues.length ? null : perPortion + (weightedSide ?? 0);
    const options = recipe.options.map(option => {
      const extra = sumLines(option.lines, []);
      return { name: option.name, cost: perPortion === null || extra.cost === null ? null : perPortion + extra.cost, issues: extra.issues, provisional: batch.provisional || extra.provisional, lines: extra.lines };
    });
    const issues = [...new Set([...batch.issues, ...sideIssues, ...options.flatMap(option => option.issues)])];
    const provisional = batch.provisional || usedSides.some(side => side.provisional) || options.some(option => option.provisional);
    return { id: recipe.id, name: recipe.name, notes: recipe.notes || [], lines: batch.lines, knownCost: batch.knownCost / recipe.portions, baseCost: perPortion, totalCost: total, status: issues.length ? "pending" : provisional ? "provisional" : "calculated", issues, provisional, sides: sides.map(side => ({ ...side, weight: totalCount ? side.count / totalCount : null, combinedCost: perPortion === null || side.cost === null ? null : perPortion + side.cost })), weightedSideCost: weightedSide, options, saleNet: recipe.saleNet ?? null, ingredientCostPercent: total !== null && recipe.saleNet && !options.length ? total / recipe.saleNet * 100 : null, contribution: total !== null && recipe.saleNet && !options.length ? recipe.saleNet - total : null };
  });
  return { scope: bundle.scope, sourceReadAt: bundle.sourceReadAt, salesPeriod: bundle.salesPeriod, recipes, items: Object.fromEntries([...items.keys()].map(id => [id, evaluateItem(id)])), counts: { total: recipes.length, calculated: recipes.filter(x => x.status !== "pending").length, pending: recipes.filter(x => x.status === "pending").length, provisional: recipes.filter(x => x.provisional).length } };
}
