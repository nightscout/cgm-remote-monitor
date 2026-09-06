# Swagger UI maintenance and server loading (M09 partial)

Upgrade swagger-ui-express 4.6.3 to 5.0.1 and swagger-ui-dist 4.19.1 to
5.32.15, the latest published npm releases checked on 2026-09-06. The wrapper's
GitHub releases also list 5.0.2, but npm's versions and latest tag stop at 5.0.1;
do not substitute an unpublished artifact. Review sources:
[wrapper changes](https://github.com/scottie1984/swagger-ui-express/compare/4.6.3...5.0.1),
[UI 5 release](https://github.com/swagger-api/swagger-ui/releases/tag/v5.0.0) and
[UI 5.32.15](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.15).
UI 5 supports the existing OpenAPI 3.0 documents; the specifications and API
request/response contracts are unchanged.

The wrapper now imports the absolute-path helper directly. Version 4 required
the distribution's main module, which evaluated both browser bundles inside
Node just to obtain their filesystem path. The new consumer test verifies that
loading the real server docs middleware does not evaluate either browser bundle.

Also fix a reproduced existing route-isolation bug: HTML requests for v1 then
v3 followed by the v1 initializer returned the v3 schema. Register each document
with serveFiles(schema) and setup(schema), so each mount owns its initializer.
The small api-docs module is the production registration used by the fixtures.
Preserve /api-docs, /api3-docs and both legacy redirect contracts.

Validation covers:

- Interleaved HTML/initializer requests for both complete real specifications,
  static assets, trailing-slash redirects and package-metadata rejection.
- Actual server docs routes and legacy redirects in the existing production/
  development HTTP-contract fixture.
- Real Chromium/WebKit authentication dialogs and two read-only status requests
  per API, requiring the expected Bearer header at a disposable loopback server.
  External browser requests are blocked and unexpected attempts fail the tests.
- Nightscout's actual enforced CSP, retrieved from the app factory; mobile-width
  authorization, keyboard operation and light/dark theme controls.
- Existing full backend/browser suites and current-head hosted gates before merge.

Local results: Node 22 backend 2,089 passing before the final two consumer
checks; Node 24 backend 2,090 before the final analytics check, each with one
existing pending case. All four final consumer checks pass on both Nodes; full
Node 22 Chromium passes 577 cases. Focused WebKit checks pass for authentication,
CSP and mobile controls. Clean install/build, application lint (zero errors,
16 existing warnings) and full npm audit (zero known advisories) pass. Hosted
checks must cover the final combined head before merge.

The new distribution declares @scarf/scarf 1.4.0 for installation analytics.
Disable it project-wide using scarfSettings.enabled=false, the
[supported opt-out](https://docs.scarf.sh/package-analytics/). A child-process test
runs the installed reporter with the real dependency tree/root manifest and
requires its disabled result before any HTTP(S) request; network attempts are
intercepted and fail. This package remains declared upstream and is not used by
Nightscout's request handlers. Do not add a fake replacement or force an unrelated
package version merely to hide a dependency path.

Measurements:

- Seven fresh processes per version and Node floor, each registering both docs
  and serving two cycles of HTML/initializer requests, followed by server close
  and GC. Median incremental heap falls 11,472,728 -> 1,543,632 bytes on Node 22
  and 11,770,424 -> 1,555,008 on Node 24: approximately **9.5–9.7 MiB less retained
  heap in this isolated middleware workload**. This is not a whole-server,
  container, or production-memory measurement. RSS is recorded but is noisier.
  [Raw trials](../audits/swagger-middleware-heap.json); reproduce with
  `node --expose-gc tools/audits/swagger-middleware-probe.cjs /path/to/checkout`.
- The two packages plus newly declared Scarf grow 8,677,768 -> 11,832,618 regular
  file bytes, excluding symlinks and nested node_modules: **3,154,850 more bytes**.
  Production package paths increase 276 -> 277. Only these three production
  package entries change; no unrelated production version is updated.
- Main documentation JS/CSS gzip level 9 totals rise 452,185 -> 526,149 bytes:
  **73,964 more bytes**. This is a matched asset-compression comparison, not an
  exact HTTP transfer measurement. [Asset/package details](../audits/swagger-package-comparison.json)
  cover the two Swagger packages; Scarf contributes a further 38,647 file bytes.
- All six Nightscout application/page JavaScript bundles remain byte-identical.

Visual comparison at 1280px and 390px shows the new theme control and an explicit
OAS 3.0 badge. The theme control wraps the mobile header onto another row; code
and description spacing changes slightly. Documentation content remains readable,
and tested authorization/execute controls work. Accept these documentation-only
UI changes if the final browser gates pass. This does not replace physical
Safari/VoiceOver validation for the modernization release.

No API authentication or deployment-setting migration is introduced. Restore
manifest/lockfile, route registration and associated consumer tests together to
roll back. M09's remaining dependency/override audit stays open.
