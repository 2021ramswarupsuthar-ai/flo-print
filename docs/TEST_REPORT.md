# Test report

Run in the build environment (Linux, Node 22, Python 3.12, Chromium via Playwright).

| Suite | What it covers | Result |
|---|---|---|
| `npm test` (17 tests) | sign-in, CSRF, lock-out, roles, chunked upload, idempotent submit, validation (type/signature/size/pages/settings), FIFO queue, one-job-at-a-time per printer, lease expiry, retry limits, uncertain-print hold + admin resolve, cancel, print-again, retention cleanup, agent isolation | 17 / 17 pass |
| `print-agent` tests (15) | real backend + real agent worker with a fake Windows printer: claim, multi-part download + SHA-256, JPEG render, settings passed to printer, duplicate-claim blocked, printer-not-ready retry, uncertain print, wrong printer, corrupt image | 14 pass, 1 skipped (needs PyMuPDF) |
| `tests/e2e/run.mjs` (Chromium, 20 checks) | intro animation, login, creating a connection key, uploading, unsupported file message, page-range validation, queue live updates, cancel, print again, job details, user management, staff isolation, mobile layout without sideways scroll, no console errors | all pass |

## Not testable in the build environment (verify on your side)

* Real printing to the Epson L6270 through Windows (GDI + spooler) and PDF rendering with PyMuPDF. This code is the same proven code the existing Jhandewalas print agent uses, but run `test-page.bat` and print a real PDF once.
* Deployment on Vercel with a real Neon database (SQL is written to run on both Postgres and SQLite; tests ran on SQLite).
* The `vite build` step itself (the app was bundled and run with esbuild + React 19 for the tests; Vercel builds with Vite).
