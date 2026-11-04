export type Scope = { clientId: string; account: string; area: "Food" };
export type RecipeLine = { itemId: string; quantity: number; unit: string };
export type RecipeBundle = {
  schemaVersion: 1; scope: Scope; clientName?: string; sourceReadAt: string; salesPeriod?: string;
  items: Array<{ id: string; name: string; unit: string; scope: Scope; kind: "material" | "preparation" | "yield"; conversion?: { gramsPerMl: number; authority: string }; prices?: Array<{ unitCost: number; enteredAt: string; source: string; origin: "invoice" | "recorded" | "manual" | "estimate"; scope: Scope }>; lines?: RecipeLine[]; outputQuantity?: number; rawId?: string; yieldRatio?: number }>;
  recipes: Array<{ id: string; name: string; portions: number; lines: RecipeLine[]; notes?: string[]; sides: Array<{ itemId: string; count: number }>; options: Array<{ name: string; lines: RecipeLine[] }>; saleNet?: number | null; saleSource?: string }>;
};
export type EvaluatedLine = RecipeLine & { name: string; cost: number | null; knownCost: number; issues: string[]; provisional: boolean; source?: string; priceDate?: string; kind?: string };
export type Evaluation = { cost: number | null; knownCost: number; issues: string[]; provisional: boolean; source?: string; priceDate?: string; lines: EvaluatedLine[] };
export type EvaluatedRecipe = {
  id: string; name: string; notes: string[]; lines: EvaluatedLine[]; knownCost: number; baseCost: number | null; totalCost: number | null; status: "pending" | "calculated" | "provisional"; issues: string[]; provisional: boolean;
  sides: Array<Evaluation & { itemId: string; name: string; count: number; weight: number | null; combinedCost: number | null }>;
  weightedSideCost: number | null; options: Array<{ name: string; cost: number | null; issues: string[]; provisional: boolean; lines: EvaluatedLine[] }>;
  saleNet: number | null; ingredientCostPercent: number | null; contribution: number | null;
};
export function convertQuantity(quantity: number, from: string, to: string, conversion?: { gramsPerMl: number; authority: string }): number;
export function validateBundle(bundle: unknown): RecipeBundle;
export function evaluateRecipes(bundle: RecipeBundle): { scope: Scope; sourceReadAt: string; salesPeriod?: string; recipes: EvaluatedRecipe[]; items: Record<string, Evaluation>; counts: { total: number; calculated: number; pending: number; provisional: number } };
