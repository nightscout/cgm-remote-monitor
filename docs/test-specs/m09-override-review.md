# Remaining security overrides and authorization dependency review

Reviewed 2026-09-06 as part of M09. This review removes the 17 remaining root
`overrides` entries. The committed lockfile retains previously patched releases;
only flatted 3.4.2 → 3.4.4 and the two Ajv 8.18.0 → 8.20.0 copies change.
Ajv 6 remains 6.15.0 for ESLint. There is no bulk lockfile regeneration.

## Resolution evidence

[Parent-range evidence](../audits/m09-override-parent-ranges.json) records all 27
relationships involving the former overridden packages and their parent scopes.
Every resolved version satisfies its parent's declared dependency/peer range.
The old brace-expansion 1/2 overrides have no remaining consumers. Nested
schema-utils/ajv-formats overrides duplicate the general Ajv 8 rule.

A separate fresh resolution without overrides selects the same patched major
lines, newer flatted/Ajv 8, and optional js-yaml 5 for webpack CLI. Its unrelated
hoisting changes are not adopted. The existing lock keeps optional CLI js-yaml
4.3.2 where installed, required NYC 3.15.2 and Mocha 5.4.1. Legacy peer mode may
omit the optional CLI parser; builds use JavaScript configuration and the tests
cover the explicit missing-parser error. Use `npm ci` for reproducible builds.
Removing pins permits future compatible fixes; it does not remove regression
coverage or promise that every future upstream release is safe.

## Changed package behavior and reachability

[Ajv's source comparison](https://github.com/ajv-validator/ajv/compare/v8.18.0...v8.20.0)
changes its format registry to a null-prototype object. Inherited property names
must not be treated as registered formats for `$data` format references.
`tests/dependency-ajv8.test.js` exercises both actual build-tool copies through
schema-utils and ajv-formats, with invalid inherited names followed by valid and
invalid registered-format values. Both copies are development/build dependencies;
Nightscout does not expose this validator as an application request parser.
A direct before/after probe accepts `constructor` on 8.18.0 and rejects it on
8.20.0. Existing fast-uri and actual webpack build tests remain required.

[Flatted's source comparison](https://github.com/WebReflection/flatted/compare/v3.4.2...v3.4.4)
contains TypeScript nullable-replacer typing, non-JavaScript bindings and development
maintenance changes; its JavaScript implementation is unchanged. It is reached
through flat-cache in the development lint/cache tree. Native JSON cannot replace
a transitive circular-JSON persistence format without changing the owning tool.

The remaining retained patched dependencies include runtime query parsing (`qs`),
HTML/CSS sanitization (`postcss`), socket protocol parsing (`socket.io-parser`),
SOCKS address handling (`ip-address`), and node-cache's lodash. Glob matching,
YAML configuration and URI/schema validation also serve build/test tools.
Existing consumer-specific dependency tests protect these paths. Full and
production npm audit snapshots report zero known advisories; that is advisory
coverage, not a claim that all application behavior or embedded vendor code has
been exhaustively audited.

## Retain shiro-trie

Installed and latest published version is 0.4.10; it has no dependencies and
50,773 published unpacked bytes. Keep it for now. Server authorization/storage,
API3 security and browser permission groups all use its trie semantics. These
include wildcard inheritance and comma-separated permission alternatives, as
specified in the [upstream documentation](https://github.com/entrecode/shiro-trie).
Node has no equivalent permission-policy engine. A local replacement would move
security-sensitive policy code into Nightscout for a small package reduction,
without an established memory benefit. This is a retention decision, not a
complete security certification of the library. Do not broaden which users can
supply permission definitions as part of dependency cleanup.

## Validation and boundaries

Clean Node 22 install/build succeeds without overrides. All six application
JavaScript bundles match the preceding Swagger candidate byte for byte. No
application/UI behavior change or server RAM saving is claimed. Two Ajv copies
and flatted are the only version changes; production package entries are unchanged.
All 300 dependency tests pass on Node 22 and 24. An initial Node 24 run
returned an unexpected 404 in the existing Express empty-body fixture; the
isolated suite, full dependency rerun and ten additional isolated Express runs passed. Keep this observation visible
until full backend and hosted checks are complete. Full backend coverage,
Node 24/npm 12 installation and hosted CI remain merge gates. The CI environment matrix is unchanged.

M09 stays open until this child and the Swagger child have passed their hosted
checks and the final inventory is reconciled. The xml2js 0.5.0 hold is documented
in [its review](xml-parser-review.md). Cache replacement, date-library selection
(including Day.js) and browser-widget migrations retain their M25/M27/M28 scopes.
