# Kitchen invoice review prototype

Open `/revision-facturas.html` on the local Vite server (`npm run dev`). Build the standalone entry with `npx vite build --config vite.review.config.js --configLoader runner`; output is `dist-review/`. The normal CMS entry and production build are unchanged.

The prototype opens a local PDF/JPG/PNG/WEBP (10 MB maximum), supports manual line correction, computes net cost by kg/unit/L using the shared domain functions, and reconciles documentary VAT and additional taxes. Unknown fields remain null. Editing a line clears its review acknowledgement. Changing the net or VAT clears the exceptional VAT acknowledgement. Delivery and nonfood supplies require a treatment note and are excluded from cost conversion.

Drafts can be downloaded as JSON and recovered (2 MB/500-line limit, shape validation). Open the matching original document before recovering a draft; the JSON does not contain the original. Drafts remain drafts even with balanced totals. The duplicate warning uses client, supplier tax ID, document type and literal folio, and checks only downloaded drafts in the current tab/session. No original files, customer data, or secrets are committed.

This is a local review prototype, not an integrated invoice module: no OCR, catalogue association, server persistence, global duplicate query, CSV export or SH writes. It makes no API calls and has no production navigation entry. Do not merge/deploy as a completed invoicing module. Production publication requires separate owner approval.

Validation: `node --test tests/invoicing-*.test.js`, `npm run build`, standalone build. Browser checks cover the sample calculation (20 kg at 1000 net/kg), review reset after changing quantity, and mismatched totals. The sample is fictional. Existing report routes and PDF endpoints have not been exercised in this iteration; no server routing changes were made.
