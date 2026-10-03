# UUID compatibility and identifier regression tests

PR #8529 originally proposed UUID 9.0.1 to 14.0.0. Current `dev` already
uses 11.1.1, the latest CommonJS-compatible release as of 2026-09-05.
The registry's latest release is 14.0.2. UUID 12 removed CommonJS builds;
loading 14.0.2 with `require('uuid')` fails with `ERR_REQUIRE_ESM` on Node
20.0.0. Nightscout supports Node >=20.x and loads API v3 synchronously.
Retain 11.1.1 until that runtime/module compatibility boundary is deliberately
migrated. Successful tests on the latest Node 20 patch alone do not establish
compatibility with the entire supported range.

UUID 11.1.1 includes the buffer bounds fix for
[GHSA-w5hq-g745-h8pq](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).
Nightscout's direct call uses v5 without an output buffer. Transitive UUID 3
(request) and 8 (coverage tooling) remain governed by their consumers; this PR
does not force incompatible transitive major versions.

`tests/dependency-uuid.test.js` covers:

- Synchronous API module loading with require(ESM) disabled where supported.
- Fixed v5 identifiers for glucose entries, distinct treatment types, missing
  devices, Unicode and adjacent timestamps. Expected values were independently
  calculated from SHA-1 of the existing namespace bytes plus UTF-8 key and
  the UUID version/variant bits; they are not derived by the code under test.
- Stable identifiers after non-identity fields change and repeated processing.
- Preservation of caller-supplied identifiers.
- Rejection of undersized buffers and invalid offsets without partial writes,
  plus valid offset writes and untouched surrounding bytes.

These tests run in both the main Node/MongoDB CI matrix and the dependency
suite in the npm 12 job. A fixed-identifier API v3 integration test also runs two full create,
deduplicate, read and permanent-delete cycles and checks that each repeated
upload leaves exactly one record. Existing update tests continue to run.

Run focused checks with:

```sh
npx mocha --timeout 5000 --exit tests/dependency-uuid.test.js
npm run test:dependencies
npm run test-ci
npm run test:core
```

No production code, package version, lockfile or UI changes are required.
The new checks protect existing persisted identifiers and startup behavior.

Upstream references:
[CommonJS policy](https://github.com/uuidjs/uuid#readme),
[release history](https://github.com/uuidjs/uuid/blob/main/CHANGELOG.md).
