# Kitchen invoice module — implementation in progress

This branch starts the approved kitchen-only invoice project. It is not a usable
invoice module yet and must not be deployed as a completed feature.

## Implemented foundation

`server/invoicing/domain.js` contains pure rules for net-cost conversions,
client/supplier/presentation-scoped matching suggestions, comparable-unit price
alerts and mandatory operator review. Tests use synthetic data only. These
functions have no storage, network or UI side effects. Review flags are domain
inputs; the eventual authenticated API must supply operator identity and validate
selected catalog IDs, client authorization and conversion approvals server-side.

## Remaining implementation

- Private durable originals, separate invoice tables and transactional confirmation.
- Authenticated upload/extraction, image/PDF vision and CSV parsing.
- Catalog/supplier adapters and learned rules loaded by authorized client.
- Review UI, invoice register, immutable cost history and duplicate protection.
- SH CSV exporter and manual import guide; no direct SH writes.
- Integration/security tests and existing report web/PDF regression checks.

## Import observations (read-only inspection, 2026-10-04)

SH Food's `/invoiceUpload/` screen allows column assignment after file selection.
Delimiter options are comma and pipe; qualifiers include double quotes. The
column selector distinguishes Name, Quantity, Weight, Unit of Purchase, Unit Price,
Ext. Price, Product Code, Item Code, Size (numeric), Unit (unit of measure), Pack
Description, Case Size, Case Description, Invoice Number, Invoice Date and Vendor
Name. The importer also distinguishes matching with or without size.

An exported invoice CSV is not, by itself, proof of an accepted import schema.
No file was uploaded or imported during this inspection. Confirm the operator's
price convention and validate an output sample in the agreed manual workflow.
Export only net costs; VAT remains documentary data and is never an import cost.

## Verification

Run `node --test tests/invoicing-domain.test.js`, `node --check server/index.js`,
`npx tsc --noEmit` and `npm run build`. Before proposing release, additionally
verify `/r/:token` and `/api/module1/reports/:id/export` with an authorized fixture.
