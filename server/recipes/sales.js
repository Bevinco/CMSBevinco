const validDay = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function validateActualSales(sales, recipes) {
  if (sales === undefined) return;
  if (sales?.source !== "Toteat" || !validDay(sales.startDate) || !validDay(sales.endDate) ||
      sales.startDate > sales.endDate || !Array.isArray(sales.rows) || sales.rows.length > recipes.length) {
    throw new Error("Las ventas Toteat necesitan un período y filas por receta.");
  }
  const recipesById = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const seenRecipes = new Set();
  const seenCodes = new Set();
  for (const row of sales.rows) {
    const recipe = recipesById.get(row?.recipeId);
    if (!recipe || seenRecipes.has(row.recipeId) || !Number.isFinite(row.units) ||
        !Number.isFinite(row.netRevenue) || !Array.isArray(row.productCodes) || !row.productCodes.length) {
      throw new Error("Fila de ventas sin receta, unidades, ingreso neto o código Toteat válido.");
    }
    seenRecipes.add(row.recipeId);
    for (const code of row.productCodes) {
      if (typeof code !== "string" || !code.trim() || code !== code.trim() || seenCodes.has(code)) {
        throw new Error("Un código Toteat está vacío, repetido o asignado a más de una receta.");
      }
      seenCodes.add(code);
    }
    if (row.options === undefined) continue;
    const names = new Set(recipe.options.map(option => option.name));
    if (!Array.isArray(row.options) || !row.options.length || row.units <= 0 || row.options.length > names.size) {
      throw new Error("Las elecciones Toteat necesitan una receta con opciones y unidades positivas.");
    }
    let optionUnits = 0;
    for (const option of row.options) {
      if (!names.delete(option?.name) || !Number.isFinite(option.units) || option.units <= 0) {
        throw new Error("Elección Toteat desconocida, repetida o sin cantidad válida.");
      }
      optionUnits += option.units;
    }
    if (Math.abs(optionUnits - row.units) > 0.000001) {
      throw new Error("Las elecciones Toteat deben cubrir todas las unidades vendidas del plato.");
    }
  }
}

export function evaluateActualSale(row, recipe) {
  if (!row) return null;
  const { units, netRevenue } = row;
  const hasSales = units !== 0 || netRevenue !== 0;
  let costBasis = null;
  if (hasSales && recipe.totalCost !== null) {
    if (!recipe.options.length) {
      costBasis = recipe.totalCost * units;
    } else if (row.options) {
      const costs = new Map(recipe.options.map(option => [option.name, option.cost]));
      if (row.options.every(option => costs.get(option.name) !== null)) {
        costBasis = row.options.reduce(
          (sum, option) => sum + (costs.get(option.name) + (recipe.weightedSideCost ?? 0)) * option.units,
          0,
        );
      }
    }
  }
  const contribution = costBasis === null ? null : netRevenue - costBasis;
  return {
    ...row,
    hasSales,
    netPerUnit: units > 0 ? netRevenue / units : null,
    ingredientCost: costBasis,
    contribution,
    marginPercent: contribution !== null && netRevenue > 0 ? contribution / netRevenue * 100 : null,
    provisional: recipe.provisional,
  };
}
