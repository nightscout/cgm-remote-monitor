# CI coverage and execution cost

The maintainer selected floating Node 22/24 only for PR CI. Keep the declared
Node minimum patches and MongoDB 5/6 migration support unchanged.

| Checks | Before | After | Coverage |
| --- | ---: | ---: | --- |
| Backend and client-core | 12 | 8 | Both Node majors on each MongoDB 5/6/7/8 |
| Replica failover | 8 | 4 | MongoDB 5/7 on Node 22, MongoDB 6/8 on Node 24; two primary changes per job |
| Browser | 6 | 4 | Chromium on both Node majors; Firefox/WebKit on Node 24 |
| npm 12 | 1 | 1 | Clean install, production and development builds, dependency tests |
| Native Docker | 2 | 2 | amd64 and arm64 build plus pruned startup |

This reduces main-workflow PR jobs from 29 to 19 (34.5%). CodeQL is unchanged.
No test assertions or test files are removed. The reduction does omit repeated
failover for the other Node/MongoDB pairs and Firefox/WebKit harness execution
on Node 22; all database pairs retain full backend coverage and all browser
engines retain their complete suite. Node 22 still builds and exercises HMR in
Chromium. This is selective environment coverage, not equivalent exhaustive
cross-product coverage.

Every setup-node step uses `check-latest: true` and npm download caching keyed
by the lockfile. `npm ci` still creates fresh node_modules and runs builds;
neither installed modules nor build outputs are restored. Cold cache runs can
remain expensive. Docker PR validation starts alongside other tests; publishing
still waits for all main test groups and now also waits for the npm 12 check.
Superseded PR runs are cancelled within that PR only. Push/release runs are not
cancelled by this policy.

The support range and runtime-policy tests remain authoritative for admission,
but simulated version strings do not prove actual minimum-patch compatibility.
The [release gate](../runtime-upgrade.md) requires testing the exact supported
floors on the final candidate outside this floating-only PR matrix. If a future
dependency requires a higher patch, resolve the mismatch before release.

Validate workflow syntax with actionlint and inspect the actual PR job set,
results, Node versions and Docker start times. Compare job execution seconds
and critical-path wall time with parent runs; fewer jobs are not automatically
a proportional wall-time improvement. Keep runner variance and cold/warm cache
conditions explicit. No runtime, database schema or UI behavior changes here.
