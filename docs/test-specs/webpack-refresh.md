# Webpack and built-in development HMR (M09 partial)

Update webpack 5.106.2 to 5.110.3 and webpack-dev-middleware 8.0.3 to 8.3.0,
the registry releases checked on 2026-09-06. Both support Nightscout's Node
22/24 floors; middleware requires webpack ^5.101.0. Review sources:
[webpack releases](https://github.com/webpack/webpack/releases) and
[middleware 8.3.0](https://github.com/webpack/webpack-dev-middleware/releases/tag/v8.3.0).

The middleware now owns both development assets and HMR's `/__webpack_hmr`
Server-Sent Events endpoint. Remove webpack-hot-middleware and use the bundled
client in all six entries. Keep a one-second heartbeat, disable reload fallback
and the new progress badge/runtime-error overlay, and retain compile-error
reporting. Resolve the exported client path before appending query options:
the direct package-subpath query failed resolution in this installed pair.
The fixture closes middleware before its HTTP server so SSE clients and compiler
watching are released before shutdown.

Webpack's default JavaScript minifier moved from terser-webpack-plugin to
minimizer-webpack-plugin. Remove the unused old override and exercise Ajv/fast-uri
through the actual new consumer. The lockfile includes the updated resolver,
watcher, sources, minifier and in-memory filesystem dependencies. No production
package path changes are introduced.

The first browser run detected that the original CSS sources moved from the JS
source map into inline maps in injected styles. Original source content was not
lost. The asset test now checks the maps actually delivered to the page and
requires exact original CSS content plus nonempty mappings. CSS minification
remains enabled. Existing mobile/desktop cascade and image URL checks remain.

Regression coverage:

- Existing page HMR test applies two changes to each page entry and shared app,
  retaining draft input, public exports, widget functions and styles without a
  page reload or external request.
- An added browser test performs two compile-error/recovery cycles, requires the
  error overlay to appear and disappear, and preserves unsaved input and report
  exports without a page reload.
- Existing asset tests validate CSS hot updates, source maps, stylesheet cascade
  at mobile/desktop widths, and unchanged toolbar image bytes/URL.
- Existing real-server HTTP asset tests exercise every development entry plus
  production routes and response contracts. Production browser tests cover page
  startup, reports/charts, editor interactions, tooltips and service workers.
- All 292 dependency cases pass on Node 24. Clean Node 22 installation and
  production build pass, with no known vulnerabilities reported by npm audit.
- Full Node 22 Chromium suite passes 538 cases, including production asset and
  report/interaction coverage. Full Node 24/MongoDB 8 backend coverage passes
  1,947 tests with one existing pending case.
- Nine focused Node 24 WebKit HMR/asset/cascade checks pass, including both
  compile-error recovery cycles. Full current-head hosted CI remains required
  before integration.

[Matched measurements](../audits/webpack-refresh-comparison.json) show one fewer
direct declaration and five fewer package paths, but **4,431,567 more installed
file bytes** in the development tree. Production paths are unchanged. App gzip
increases 5,086 bytes; the total app/page-entry gzip increase is 5,073 bytes.
These are installed file and transfer measurements on Node 22, not image size,
build-time or server heap/RSS results. The original-source inline CSS maps and
new build-tool functionality have a cost; this update is not a size-saving claim.

No deployment configuration change is required. Production rendering and
interaction contracts remain required gates; development compilation errors
use the new middleware's overlay. Restore the manifest, lockfile, development
middleware/client wiring and associated consumer checks together to roll back.
