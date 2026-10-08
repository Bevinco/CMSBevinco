# Kitchen invoice pilot

The pilot accepts a PDF (up to 10 pages), image or Sculpture purchase CSV, preserves the original, extracts an **unconfirmed** draft, and provides a side-by-side review with the client catalog. A reviewer selects the exact SH supplier/product/presentation, checks quantity and net amount, saves, and confirms. Confirmation never writes to SH.

## Run the isolated review

```sh
npm ci
npx vite build --config vite.review.config.js --configLoader runner
# Optional OPENAI_API_KEY in the process environment for document reading.
# INVOICE_LOCAL_DB can point to a private persistent development directory.
node server/invoicing/preview.js
```

Open `http://127.0.0.1:4317/revision-facturas.html`. This localhost-only server has its own SQLite database at `data/invoicing/review.sqlite`; it never opens the CMS store, mail integrations, or SH. Do not expose this development server publicly. Seed catalog/reference records only with authorized private data outside git. The repository contains synthetic tests only.

## Workflow and limitations

- Extraction uses the Responses API, `store:false`, a strict schema, and no tools. Model output is untrusted. Unknowns stay null; editing never approves a line. Re-reading replaces the saved draft with a fresh, unconfirmed extraction and retains the original. A failed initial extraction preserves the original in a manual draft.
- The pilot is limited to kitchen client `28922`. Production routes use existing CMS authentication and `module1` permission; only Superadmin can replace its catalog. Client URLs outside the allowlist are rejected. Source documents are served through authenticated, non-cacheable routes.
- Suppliers, product IDs and presentation IDs must belong to the selected client's catalog. Known physical contents must balance with the SH quantity. Weight, volume, pieces and cooking yield are separate. Zero/incomplete package sizes block confirmation/export.
- Source hashes and client + supplier tax ID + document type + literal folio prevent duplicates among saved records. A private reference record marked `existingInSh` cannot be exported. This is **not a live, exhaustive SH duplicate check**; verify the current open period before any manual import.
- Saving uses an optimistic version and database unique constraints. Stale edits return 409. Only confirmed, explicitly selected, non-provisional fixed-format associations become learned suggestions. Suggestions require review again and are invalidated when the target catalog presentation changes. Exact-ID comparable earlier costs can raise configurable price alerts; absent history is stated explicitly.
- CSV export is manual and gated by confirmation. Assign `total_cost` to **Ext. Price**, preserving the net line amount instead of recalculating a rounded unit price. Taxes are zero. Delivery and nonfood supplies are excluded from product rows and delivered in a separate header summary; apply those charges **once** in SH. The CSV has not been imported into a live SH period as part of this pilot.
- The photo/PDF reader is not reliably exact on faint scans. In the private six-document trial it found all folios/net headers, but misread several quantities/line amounts and one date. All six passed after human review; do not market this as unattended OCR. The private reviewed fixtures preserve the raw extraction separately.

## Production activation (not performed)

`INVOICING_ENABLED` is false unless explicitly set to `true`. The CMS sidebar discovers the module only when its authenticated config route is available. Build includes the review page, but the feature flag leaves the API disabled by default.

1. Review `migrations/20261007_kitchen_invoices.sql` and apply it using Supabase `apply_migration` to an isolated branch first. It adds dedicated `kitchen_invoices`, `kitchen_catalogs` and an atomic save RPC. It never changes `cms_store`.
2. Validate on staging with a service-role credential in the backend. RLS is enabled; anon/authenticated roles have no table/RPC access. Never provide a service-role credential to the browser.
3. Load the authorized client catalog and known SH invoice references; validate exact IDs, formats and supplier names.
4. After owner approval, apply the migration to production, deploy the reviewed branch, and enable `INVOICING_ENABLED=true`. Render autodeploys main, so do not merge before publication approval.
5. Verify with a **new, not-yet-loaded invoice** and review its manual import in an open SH period. Do not reimport the reference lot.

## Verification

Run `node --test tests/invoicing-*.test.js`, `node --check server/index.js`, `npm run build`, and the standalone build above. Tests cover net/format conservation, incomplete formats, learned-rule scope, earlier comparable costs, CSV parsing, duplicate and stale-write protection, provider boundary, HTTP confirm/export, and the actual migration in isolated PGlite/Postgres. A separate local CMS smoke test exercises login, bootstrap, existing report export, shared report HTML/data and unauthorized/invalid requests. Production Supabase/Render were not modified.

Official API references: [PDF/file inputs](https://developers.openai.com/api/docs/guides/file-inputs), [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
