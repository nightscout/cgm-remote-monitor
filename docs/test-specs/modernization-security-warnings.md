# Modernization CodeQL warnings

Review of #8605 found two active alerts on its merge ref: #114
(`js/sensitive-get-query`, test fixture) and #64
(`js/server-side-unvalidated-url-redirection`, API3). Earlier fixture alert #103
was already fixed. A green CodeQL check did not mean the branch had zero open
warnings: query severity and findings inherited from the base matter.

The browser measurement fixture now requires the `api-secret` header and never
reads a query credential. Both measurement tools supply the fixed, synthetic
credential through Playwright context headers. The unchanged historical client
can therefore authenticate without a query fallback in the fixture. Normal
fixture authentication tests stay private; no alert suppression or dismissal is
used. Historical raw measurements retain their original source hashes.

API3 create and deduplicating replacement now construct Location from the
registered `/api/v3` prefix, configured collection name and separately encoded
identifier. Request paths and proxy/Host metadata are not inputs. Both handlers
share the construction, including the equivalent replacement path not identified
by the original alert. UUID/ObjectId response identifiers, status codes, stored
documents and ordinary URLs are unchanged. Case-insensitive/trailing-slash POSTs
return the canonical resource URL. The adversarial unit request demonstrates why
request-derived URLs are an unsafe construction pattern; it is not a claim that
an external redirect was reproduced through the deployed Express route chain.

Five new regressions fail before the fixes: four create/deduplication cases using
UUID/ObjectId identifiers with adversarial request paths, and one fixture case
where an outdated caller requests query authentication. Afterward they pass on
Node 22.23.2 and 24.20.0. The existing real API persisted-UUID lifecycle additionally
covers mixed-case/trailing-slash create and deduplication URLs, readable canonical
Location, storage/cache output and deletion over repeated cycles.

Run the focused cases with:

```sh
node node_modules/mocha/bin/mocha.js --timeout 10000 --exit \
  tests/api3-location.test.js tests/page-fixture-traffic.test.js
```

Full backend/client-core/dependency/installed-connector tests, browser startup and
service-worker journeys, and current-head hosted CI/CodeQL remain merge gates.
Inspect open alerts specifically on `refs/pull/8605/merge` after integration;
alerts can remain open on master/dev until the integration PR is merged there.
Rollback reverts the child commit; it restores the warned URL constructions.
There is no dependency, schema, identifier-format or production auth migration.
