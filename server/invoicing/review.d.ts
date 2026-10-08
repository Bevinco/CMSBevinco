import type { Draft } from '../../src/invoicing/types';
export function duplicateKey(draft: Draft): string | null;
export function reviewDraft(draft: Draft, previous?: Draft[]): {
  errors: string[]; sum: number; readyForMapping: boolean;
  results: { issues: string[]; cost: null | { costBasis: string; baseQuantity: number; netCostPerBaseUnit: number; netLineTotal: number } }[];
};
export function parseReviewFile(text: string): Draft;
