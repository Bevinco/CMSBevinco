# Kitchen invoice pilot — reviewable branch

Implemented document intake and storage, PDF/image extraction, single-folio CSV intake, catalog association, review/confirmation, scoped learning, comparable cost alerts, duplicate/version protection, and gated CSV + header-charge export. The original scan and unedited model extraction are retained separately from the reviewed draft. No automatic SH writes.

The application runs locally with SQLite. Production persistence has a dedicated Supabase adapter and tested migration, **not yet applied to remote Supabase**. Feature activation is off by default. Neither main nor Render have been changed.

Private real-case validation: six source invoices, six folios/net headers recognized, all six reviewed cases confirm. An incomplete package was initially blocked; selecting the existing valid package resolved it without changing the shared definition. Several OCR line figures and one date needed human corrections. The source originals, customer catalog and detailed results stay outside this public repository.

Before release: stage the migration and catalog, owner reviews the concrete result, then separately authorizes publication. Validate one new invoice's manual import afterward. Existing references are blocked from re-export.

See [workflow, setup and verification](../invoice-review.md).
