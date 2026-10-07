export type Line = {
 id:string; description:string;kind:'food'|'delivery'|'supply';quantity:number|null;netLineTotal:number|null;purchaseUnit:string;costBasis:string;unitsPerPurchaseUnit:number|null;contentPerUnit:{value:number|null;unit:string};measuredTotalKg:number|null;reviewed:boolean;note:string;
 sourcePresentation?:string;productCode?:string;productId?:string;presentationId?:string;targetQuantity?:number|null;mappingReviewed?:boolean;acknowledgePrice?:boolean;learnMapping?:boolean;provisional?:boolean;printedUnitPrice?:number|null;printedLineTotal?:number|null;priceIncludesVat?:boolean|null;
};
export type Draft={id:string;clientId:string;supplier:string;supplierRut:string;supplierId?:string;documentType:string;folio:string;date:string;net:number|null;vat:number|null;otherTaxes:number|null;total:number|null;taxExceptionReviewed:boolean;warnings?:string[];lines:Line[]};
export type CatalogItem={productId:string;presentationId:string;name:string;unit:string;size:string;validFormat?:boolean;baseUnit?:string;baseUnits?:number;code?:string};
export type Catalog={clientId:string;capturedAt?:string;items:CatalogItem[];suppliers:{id:string;name:string;rut?:string}[]};
export type InvoiceRecord={id:string;version:number;status:string;draft:Draft;source:null|{name:string;type:string;hash:string};existingInSh?:{id:string;period:string};extraction?:{model:string;result:unknown};updatedAt:string};
