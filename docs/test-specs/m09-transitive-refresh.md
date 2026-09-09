# Final compatible transitive refresh (M09)

Reviewed 2026-09-06 after the override audit. `npm outdated --all` identified four
remaining updates within their actual parents' declared ranges. Only these four
lock entries change; no new dependency declaration or override is added.

| Package | Before → after | Actual parent / reason to retain |
| --- | --- | --- |
| dayjs | 1.11.20 → 1.11.23 | launder ^1.11.7, via sanitize-html; do not rewrite an upstream dependency locally |
| es-module-lexer | 2.1.0 → 2.3.2 | webpack ^2.1.0; native Node does not expose an equivalent static import/export lexer |
| extsprintf | 1.3.0 → 1.4.1 | verror ^1.2.0, via APNs; preserve upstream formatting/error contracts |
| serialize-javascript | 7.0.5 → 7.1.1 | Mocha ^7.0.2; JSON cannot preserve executable test/hook functions |

## Reviewed changes and regression coverage

[Day.js comparison](https://github.com/iamkun/dayjs/compare/v1.11.20...v1.11.23):
year-token preservation and timezone-plugin DST/invalid-value fixes. Launder
loads the core package, not the timezone plugin. Nightscout's sanitizer uses
launder's static URL predicate; it does not invoke its date helpers. Tests retain
actual sanitization behavior and smoke-test the parent's local date/time helpers.
This does not choose Day.js for M27 or migrate Moment, timezone data or therapy
calculations.

[Lexer comparison](https://github.com/guybedford/es-module-lexer/compare/2.1.0...2.3.2):
correct template-string dynamic import names, export binding enumeration and
methods named `import`; grow WASM memory for large sources and improve scanning.
A consumer-resolved test parses a source larger than 5 MiB with multiple exports,
a template import and an ordinary import-named method. Real production builds
and existing development/build-tool tests remain required.

[extsprintf comparison](https://github.com/davepacheco/node-extsprintf/compare/v1.3.0...v1.4.1):
more informative malformed-format errors. The APNs-resolved VError regression
preserves valid Unicode/string/integer/percent formatting, cause identity, name
and metadata. Do not replace the upstream formatter with native util.format:
the supported formats and invalid-input behavior differ. Existing owned TLS/APNs
transport tests remain required.

[Serializer comparison](https://github.com/yahoo/serialize-javascript/compare/v7.0.5...v7.1.1):
reject non-string URL/RegExp representations and escape script-closing prefixes
split across serialized function bodies. Tests resolve the actual Mocha copy,
reject these malformed values without coercion, reject HTML end-tag prefixes in
serialized output, and execute only owned fixture functions to verify preserved
results and comparison syntax. Existing serial/parallel Mocha hook and failure
coverage remains required. Upstream documents heuristic parsing limitations;
this is not a new application HTML templating mechanism or a claim that arbitrary
untrusted function serialization is safe. Mocha/lexer are build/test-only paths.

## Costs and validation

[Matched package-owned file measurements](../audits/m09-transitive-package-comparison.json):
Day.js +1,620 bytes, extsprintf +7,540 bytes (production); lexer +74,736 bytes and
serializer +3,105 bytes (development). No package paths are removed. All six
application JavaScript bundles are byte-identical to the preceding override
candidate. There is no claimed runtime-memory or UI improvement.

Node 22 passes 305 dependency and 2,098 backend tests (one existing pending).
A clean Node 24/npm 12 installation passes 296 dependency and 2,089 backend
cases (one existing pending); optional CLI YAML is absent in that mode. Hosted
CI and actual merge verification remain required. The [final inventory](../audits/m09-final-inventory.json) records
zero known full/production advisories and no remaining updates within consumer
ranges at the time of review.
The environment matrix and Node/MongoDB compatibility floors do not change.

After these updates, remaining direct major-version choices are flot/jQuery
(M28), node-cache (M25), and the documented xml2js 0.5.0 retention decision.
M27 continues to compare Moment/native Intl/Luxon/Day.js. Do not force transitive
major upgrades outside their owning consumers' ranges to make an outdated list
empty. This final child proposes closing M09 after its hosted CI and actual merge are
verified. Release-wide validation and the draft #8605 merge remain separate.
