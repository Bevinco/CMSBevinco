import type { EvaluatedRecipe, RecipeBundle } from "./costing.js";

export type SaleOption = { name: string; units: number };
export type SaleRow = {
  recipeId: string;
  units: number;
  netRevenue: number;
  productCodes: string[];
  options?: SaleOption[];
};
export type ActualSales = {
  source: "Toteat";
  startDate: string;
  endDate: string;
  rows: SaleRow[];
};
export type EvaluatedSale = SaleRow & {
  hasSales: boolean;
  netPerUnit: number | null;
  ingredientCost: number | null;
  contribution: number | null;
  marginPercent: number | null;
  provisional: boolean;
};
export function evaluateActualSale(row: SaleRow | undefined, recipe: EvaluatedRecipe): EvaluatedSale | null;
export function validateActualSales(sales: unknown, recipes: RecipeBundle["recipes"]): void;
