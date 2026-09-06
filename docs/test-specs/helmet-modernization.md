# Helmet 8 migration (M09)

Upgrade Helmet 4.6.0 to 8.3.0. Node 18+ is required by Helmet; both supported
Nightscout Node floors exceed this. Only the root range and Helmet lock record
change. No transitive dependency is added or removed.

## Explicit existing security policy

Helmet 5 changed CSP useDefaults and enabled cross-origin policies. An unchanged
Nightscout configuration on Helmet 8 failed four existing framing tests by
injecting script restrictions and upgrade-insecure-requests into a frame-only
CSP. Both Nightscout CSP configurations now explicitly set useDefaults:false.
The full Helmet invocation disables newly defaulted COEP/COOP/CORP and
Origin-Agent-Cluster to preserve existing embedding/resource behaviour. This
retains the prior policy, rather than weakening an enabled Nightscout setting.
HSTS, same-origin frame protection and full/report-only CSP remain configurable.

Helmet 7 removed Expect-CT. We do not add a dependency or local implementation
just to restore that retired header. The [upstream changelog](https://github.com/helmetjs/helmet/blob/main/CHANGELOG.md)
records the defaults, removal and runtime requirements.

## Evidence

- All 34 server security-header cases pass on Node 22.23.2 and 24.20.0. The
  expanded suite also passes against the original Helmet 4 implementation.
- The 24-mode [complete header comparison](../audits/helmet-header-comparison.json)
  covers HTTP/HSTS/embedding and off/enforced/report-only CSP. The only observed
  header change is removal of Expect-CT in six HSTS-enabled configurations.
- Three browser regressions use the actual server middleware serving owned
  static HTML. Cross-origin frames and inline controls work twice in each CSP
  mode, under Chromium/Node 24 and WebKit/Node 22. Existing real-page tests alone
  use fixture headers and would not establish this middleware compatibility.
- Clean install/build passes; all six production JS bundles are byte-identical.
  Helmet installed file bytes increase from 73,751 to 105,555 (+31,804). No
  package-count, browser transfer or server-memory saving is claimed.
- Changed-source lint reports zero errors and six existing filesystem warnings.

Full backend/browser, CodeQL, native Docker and pruned-runtime CI must pass on
the current base before merge. This slice does not complete M09 or the live
hosting/proxy release gates.
