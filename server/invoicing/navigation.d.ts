export type PeriodOption={id:string;label:string;startsAt?:string;endsAt?:string};
export function invoicePeriod(invoice:{existingInSh?:{period?:string|number|null}|null}):string;
export function buildPeriodOptions(invoices:{existingInSh?:{period?:string|number|null}|null}[],knownPeriods?:{id:string;startsAt?:string;endsAt?:string}[]):PeriodOption[];
