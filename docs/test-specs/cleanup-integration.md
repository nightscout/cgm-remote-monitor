# Combined cleanup verification

This branch combines #8644, #8646, #8647, #8649, #8650 and #8651 against the
verified M21 integration merge. The [source-head record](../audits/cleanup-integration-heads.json)
identifies the reviewed inputs. Each source head is an ancestor of this branch.
All 20 changed source/test/tool files match their final source PR; #8647 is the
intentional successor to #8644's report implementation. Merge resolutions keep
all plan sections, production Axios, Babel 8/loader 10, and remove direct UUID,
traverse and simple-statistics. The Babel loader's obug dependency is retained;
traverse's now-unused object-keys/object.assign entries are removed.

A clean npm ci including the production build succeeds with the combined lock.
Manifest and root lock declarations match. Direct removed-package entries stay
absent; private UUID 8/3 consumers under NYC/request and Babel's scoped traverse
are unrelated retained dependencies. No new API or generic helper is added by
this integration PR. Runtime changes remain those reviewed in the source PRs.

Full backend, separate core/dependency and real-browser validation must pass
on this combined tree, including report numeric/DST goldens, query operators,
persisted UUIDs, import privacy/proxy behavior and Babel/loader contracts. The
hosted gate includes all supported Node/MongoDB jobs, Chromium/Firefox/WebKit,
npm 12, CodeQL and both Docker architectures. Exact proposed and actual merge
trees must match verification before completion is recorded. The source PRs
remain available for review; their prior standalone results do not replace
combined validation. #8605 remains draft into dev.
