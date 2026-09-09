# Babel 8 and loader 10 migration

M08 upgrades @babel/core to 8.0.1, @babel/preset-env to 8.0.2 and
babel-loader to 10.1.1. Existing dependency classification is preserved;
production build/prune policy remains M10 work.

The [Babel migration guide](https://babeljs.io/docs/v8-migration) requires
Node ^22.18.0 or >=24.11.0 and ships ESM-only packages. Our supported floors
22.23.2 and 24.20.0 satisfy this requirement; synchronous require of Babel
and the loader integration have been exercised on both. Webpack supplies
ESM caller support, so the preset's changed modules:auto fallback does not
change the bundler contract. No React, TypeScript, Flow, loose/spec, corejs,
useBuiltIns or custom Babel plugin configuration is present.

The project .browserslistrc and .babelrc are unchanged. The new browser-data
snapshot updates percentage-based browser versions, but explicit iOS 9.3,
10.3, 13.7 and 14.8 targets remain. The oldest normalized iOS target remains
9.3.0. Babel 8 enables bugfix transforms by default. We retain those fixes
and validate behavior rather than disabling them to reproduce old output.

Nine compiler/loader contracts pass on Node 22.23.2 and 24.20.0. These cover
project-configured iOS transforms and Unicode, lexical this, nullish zero,
optional chaining, object-rest getter behavior, private state, async-generator
cleanup, invalid syntax rejection, actual duration/unit calculations in both
build modes, source maps and two cache-invalidating edits. The production
bundle succeeds. The full Node 22/MongoDB 6 backend suite passes 1,656 tests
with one existing pending; separate core/dependency suites pass 283/267.
Chromium on Node 22 and WebKit on Node 24 each pass all 509 browser cases.
The branch now includes the env-runner merge #8648; refreshed hosted validation
remains in progress; this candidate is not yet merge-ready. Development/HMR
builds pass on parent and candidate with the same two warnings, including the
existing unused convertToRanges function in profileeditor.js.

The lockfile adds 69 package paths and removes 19 (net +50), including the
compiler dependency split (NYC still needs its private Babel 7 compiler); this is a maintained-compiler migration rather
than a package-count reduction. Matched production builds on Node 22 have
779 fewer raw JavaScript bytes and 64 fewer Python gzip bytes across six
entries. See [raw measurements](../audits/babel8-bundle-delta.json). App,
clock and reports change; admin, food and profile are byte-identical. Gzip
uses Python's default level with mtime=0; source maps/license files are not
included in these JavaScript totals.

No persisted data or server API change is intended. Browser bundles do change
because the compiler changes; semantic browser regressions must pass before
merge. Modern browser execution does not prove behavior on physical iOS 9.3
hardware. No server-memory saving is claimed. Rollback restores the three
manifest versions and lockfile together, then rebuilds browser assets.
