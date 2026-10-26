# AJV 6 maintenance

Update the compatible AJV 6 override from 6.12.6 to 6.15.0. Consumers are
ESLint/eslintrc, the webpack lint plugin's schema-utils 3 and request's
har-validator. AJV 8 consumers retain 8.18.0. Only the shared AJV 6 lock entry
changes; keep it hoisted rather than installing four identical private copies.
A clean npm ci and npm ls verify this graph.

The advisory GHSA-2g4f-4pwh-qvx6 concerns data-driven regex patterns with
$data enabled. Source review matters: the release adds an optional regExp
engine and catches invalid dynamic patterns; native RegExp remains the
default and can still exhibit catastrophic backtracking. Do not describe
this version bump as universal protection against attacker-chosen patterns.
The production HAR validator creates AJV with allErrors only, not $data.
ESLint uses local rule schemas; schema-utils 3 enables $data for local build
schemas. No production Nightscout dynamic-pattern schema was identified in
these consumers. Reassess before exposing user-supplied schemas/patterns.

Sources: https://github.com/advisories/GHSA-2g4f-4pwh-qvx6 and
https://github.com/ajv-validator/ajv/compare/v6.12.6...v6.15.0.

Four tests pass on Node 22.23.2 and 24.20.0 after a clean hoisted install:
actual ESLint diagnostics/invalid options, webpack schema absolutePath and
unknown-property rejection, HAR promise/error shape, and malformed dynamic
pattern failure without throwing. The first three pass on the old version;
the fourth fails there with SyntaxError. Tests use a tiny malformed pattern,
not an expensive catastrophic-backtracking payload.

Full build/backend/dependency and hosted gates remain required. No Nightscout
schema, UI or runtime policy changes. M09 remains open for remaining audit
findings and parent maintenance. Rollback restores the override and shared
lock entry together.
