export type Line = {
  id: string; description: string; kind: 'food' | 'delivery' | 'supply';
  quantity: number | null; netLineTotal: number | null; purchaseUnit: string;
  costBasis: string; unitsPerPurchaseUnit: number | null;
  contentPerUnit: { value: number | null; unit: string };
  measuredTotalKg: number | null; reviewed: boolean; note: string;
};
export type Draft = {
  id: string; clientId: string; supplier: string; supplierRut: string; documentType: string;
  folio: string; date: string; net: number | null; vat: number | null;
  otherTaxes: number | null; total: number | null; taxExceptionReviewed: boolean; lines: Line[];
};
