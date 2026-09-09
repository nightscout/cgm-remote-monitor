# HTTP parsing dependency regressions

`tests/dependency-express.test.js` exercises Express and body-parser over HTTP
with Nightscout's shared middleware and query conversion. It runs in both
`npm run test-ci` and `npm run test:dependencies`; dependency resolution is also
checked in the Node/MongoDB and npm 12 CI jobs.

The suite covers:

- Invalid body-size configuration failing at parser construction, including
  Express's built-in parsers. Null/undefined retain the default 100kb cap.
- Nightscout's existing 1MiB JSON, form and raw boundaries; bulk JSON acceptance
  with both existing 50MiB limit formats; gzip limits applied after inflation.
- Malformed/scalar JSON rejection, nested form arrays above 100 items, the
  50,000-parameter form cap, and prototype pollution resistance.
- Repeated, bracket and indexed query arrays passed through Nightscout's query
  conversion; the default 1,000-query-parameter cap; date filters, legacy routing
  and extension-based content negotiation.

Express 4.22.2 restores array parsing above 20 elements with the current qs
release. body-parser 1.20.6 rejects invalid limit values instead of silently
disabling size enforcement. Nightscout's existing fixed limits are valid and
remain unchanged. See the [Express release notes](https://github.com/expressjs/express/releases/tag/v4.22.2)
and [body-parser advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-v422-hmwv-36x6).

These upgrades stay on the maintained Express 4 and body-parser 1 release lines.
An Express 5 migration must address wildcard/optional route syntax, writable
`req.query` assumptions, deprecated response signatures, and changed parsing
and static-file defaults before it can preserve existing client behavior.
See the [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/).
