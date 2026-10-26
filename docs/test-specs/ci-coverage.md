# CI coverage and execution cost

This page recorded the September 2026 modernization-branch matrix (floating
Node 22/24 against MongoDB 5, 6, 7 and 8). That matrix is superseded: from
16.0.0, CI tests the edges of the supported range (Node 22.23.4 and the newest
Node 26 against MongoDB 5.0 and 8.0, plus the two lanes that keep the required
check names), every browser engine on Node 26, and a manual extended run
before a release. See
[CI coverage and manual release checks](../../CONTRIBUTING.md#ci-coverage-and-manual-release-checks)
and `.github/workflows/main.yml`.

What carried over from the September change and is still in the workflow:
`check-latest: true` on every setup-node step, superseded PR runs cancelled
within that PR only, Docker PR validation started alongside the tests, and
publishing waiting for the npm 12 check.
