# Application lint baseline and CI gate (M09 partial)

The ESLint 10 migration exposed 53 errors and 47 warnings in application code.
This follow-up establishes a zero-error baseline without changing global rule
severities or hiding security warnings. [Recorded results](../audits/lint-cleanup-results.json)
show zero errors and sixteen security warnings across 227 files.

Changes are limited to unused catch bindings/parameters, values overwritten
before use, an unused private profile-editor wrapper, an unused websocket return
binding, and obsolete lint directives. Keep the websocket initialization call
and the basal translation call whose returned value was unused. Keep initial
values that are still read, including Loopalyzer's interpolation coefficients.
The intentionally unbounded MongoDB retry loop receives one local explanation:
success returns, fatal errors throw, and retryable failures continue as before.
No retry/timeout behavior is changed to satisfy lint.

Add `npm run lint` to the existing Node 22/MongoDB 5.0.32 job. It runs once per
matrix, after installation, and fails new application lint errors. This adds no
job or environment. The sixteen security warnings remain visible and do not
fail the gate; they need individual reachability review, not blanket suppression.

Regression evidence:

- `npm run lint` succeeds on Node 24 with zero errors; the Node 22 diagnostic run
  also reports zero errors and sixteen warnings.
- All 283 client-core tests pass on Node 22, including profile migration and
  treatment/data selection contracts.
- Added numerical raw-glucose fixtures cover calibration/display branches over
  repeated calls. Basal fixtures preserve translation call order and selected
  output for both normal and temporary basal over two cycles.
- Production builds pass on Node 22 and Node 24.
- Full local Node 22/MongoDB 6 backend coverage passes 1,924 tests with one
  existing pending case. All 538 Chromium browser tests pass on Node 24.
- Current-head hosted CI remains required before integration, including
  verification that the lint step runs in exactly the intended existing job.

No dependency is removed in this cleanup and no package-size, heap or RSS saving
is claimed. Keep the unused-dataflow cleanup distinct from any change to therapy
algorithms, report interpolation, authentication behavior or MongoDB lifecycle.

Follow-up: during review, the existing API3 alarm subscription failure log was
found to include the submitted access token. Track that as a separate security
fix with a sentinel-token regression; this cleanup only removes the unused
callback parameter and does not claim to fix that logging path.
