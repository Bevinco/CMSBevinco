# Client and period navigation

The review opens with Client → Period → Invoices. Only clients already allowed by the private invoice module are offered. Opening an invoice reveals the existing original/document editor; changing context closes it and prompts before discarding unsaved changes.

The protected `/:cid/periods` route returns cached CMS period dates scoped by the exact Sculpture client prefix. Invoice membership comes exclusively from `existingInSh.period`, never an inferred date range. Periods present only in saved invoice references remain selectable with a dates-pending label; empty cached periods are also listed. This view does not fetch live SH periods, claim an open/closed status, modify period assignments or write to SH. New documents remain under “Sin período asignado”.

No migration, new resource or expanded account access is needed. An unavailable periods API is surfaced as an error. Current client allowlisting and private access remain intact. The localhost preview can inject a `periodsForClient` callback using private fixtures outside this public repository.

Validation: invoice suite (30 tests), full TypeScript/Vite build, desktop and mobile browser checks, period filtering and editor reset. Production publication remains a separate approval step.
