# Helmet 8 migration (M09)

Upgrade Helmet 4.6.0 to 8.3.0. Node 18+ is required by Helmet; both supported
Nightscout Node floors exceed this. Only the root range and Helmet lock record
change. No transitive dependency is added or removed.

## Explicit existing security policy

Helmet 5 changed CSP useDefaults and enabled cross-origin policies. An unchanged
Nightscout configuration on Helmet 8 failed four existing framing tests by
injecting script restrictions and upgrade-insecure-requests into a frame-only
CSP. Both Nightscout CSP configurations now explicitly set useDefaults:false.
Explicit individual Helmet middleware preserves the existing enabled headers,
without introducing COEP/COOP/CORP or Origin-Agent-Cluster. This
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

## CodeQL follow-up after the dev refresh

PR #8605's CodeQL result flagged `js/insecure-helmet-configuration` (alert #112)
for passing false CSP/frameguard settings to the umbrella Helmet middleware.
Those configurable choices also exist on dev; CSP remains opt-in and embedding
remains configurable. Install the enabled header middleware directly and apply
the selected framing/enforced CSP once, independently of the HSTS branch.
Report-only CSP remains separate. This removes duplicated policy wiring and
makes the security settings explicit without suppressing or dismissing alerts.

The [24-mode comparison](../audits/helmet-explicit-header-comparison.json) against
`e16302fd` records identical HTTP headers and response bodies (excluding Date
and Connection). Expanded assertions check the retained nosniff, DNS-prefetch,
download, cross-domain, XSS and referrer headers, and X-Powered-By removal.
All 34 cases pass before the change and on Node 22.23.2/24.20.0 afterward.
Three actual-server browser embedding/inline-control cases pass on Chromium
and WebKit, repeating off/enforced/report-only CSP interactions twice.
The individual middleware API is documented by [Helmet](https://helmet.js.org/).
Hosted final-head CodeQL and the full CI matrix remain the final validation.
