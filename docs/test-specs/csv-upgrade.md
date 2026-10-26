# Maintained CSV dependencies (M09 partial)

API3 export uses csv-stringify; csv-parse is used only by the HTTP renderer tests.
Keep the libraries to own quoting, field casting and parser edge cases. Node's
standard library does not provide this CSV contract. This change updates the
writer from locked 5.6.5 to 6.8.3 and the test parser from 4.16.3 to 7.0.2, the
latest registry releases reviewed on 2026-09-06.

Both use named CommonJS exports. The writer imports `stringify` from
`csv-stringify`; tests import `parse` from `csv-parse/sync`. The old private
`csv-parse/lib/sync` path is no longer used. See the official
[writer](https://csv.js.org/stringify/distributions/nodejs_cjs/) and
[parser](https://csv.js.org/parse/distributions/nodejs_cjs/) distribution docs.
The callback rendering API, header option and output negotiation remain intact.

## Evidence

- Clean Node 22 install/production build and development build.
- Seventeen byte-contract and actual HTTP renderer cases pass on Node 22.23.2 /
  MongoDB 6 and Node 24.20.0 / MongoDB 8. Use `tests/ci.test.env` with a unique
  disposable MongoDB database and run Mocha with `--require tests/hooks.js
  --exit tests/api3.csv-contract.test.js tests/api3.renderer.test.js`.
- Eight byte-level regressions exercise the actual renderer: empty/single/bulk
  exports, first-row columns and missing fields, quotes/Unicode/newlines, nested
  values, dates, undefined cells and repeated exports without input mutation.
  Golden bytes were captured through the original 5.6.5 renderer and reviewed.
  These assertions do not depend on the upgraded parser agreeing with the writer.
- An old/new callback comparison produced identical bytes for 444 cases on both
  Node floors: three empty/column fixtures plus the Cartesian product of 21
  scalar/structured/date values. This is bounded fixture evidence, not a proof
  over arbitrary JavaScript objects.
- Lockfile changes only the two CSV package records and root declarations. No
  dependency paths are added or removed. Full current-head CI and merge-tree
  verification are required before integration.

## Cost and behavior

[Installed-file measurement](../audits/csv-package-comparison.json) records a
409,565-byte increase for the production writer and a 939,013-byte increase for
the test-only parser. This is a maintenance update, with no package-count or
server-memory saving claimed. It does not alter browser widgets or assets.

Export values retain their existing literal formatting, including formula-like
text. This dependency update does not introduce a spreadsheet-escaping policy.
HTTP content negotiation and XML/JSON renderer contracts remain covered by the
existing HTTP suite. Reverting the upgrade requires restoring both import forms
along with the manifest and lockfile.
