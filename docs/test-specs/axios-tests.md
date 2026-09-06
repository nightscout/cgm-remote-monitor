# Axios consumer regression tests

`tests/dependency-axios.test.js` runs under both `npm run test-ci` and
`npm run test:dependencies`. CI also validates all installed Axios resolutions.

The dependency tree intentionally retains two supported release lines:

- Axios 0.33.0 for direct consumers and `minimed-connect-to-nightscout`. Its
  axios-cookiejar-support 1.x wrapper imports Axios internal modules and cannot
  be replaced with Axios 1.x without migrating that consumer.
- Axios 1.20.0 for `nightscout-connect`, with its existing modern cookie wrapper.

Local HTTP fixtures test JSON, Unicode, nested query parameters, default and
interceptor headers, multipart uploads, explicit proxy routing/authentication,
redirects, decompression, HTTP failures, status overrides,
timeouts and recovery. Both actual cookie wrappers retain login cookies through
repeated requests. MiniMed's manual redirect, form POST and response interceptor
pattern is checked separately.

The tests invoke Nightscout's real settings-import boot stage for wrapped/flat
configuration and failure handling, and the real nightscout-connect source for
token exchange and repeated glucose reads. No external account is contacted.

Axios 0.32 introduced null-prototype config/header objects; consumers must use
`Object.prototype.hasOwnProperty.call(...)` instead of calling a method on those
objects. Request interceptor compatibility is covered. Axios 0.x redacts error
JSON by default, whereas 1.x requires explicit `redact` keys; the tests preserve
that distinction and do not claim that every application log is redacted.
Additional checks cover inherited authentication options and the 1.20 interceptor
cleanup fix.

No visual or user configuration changes are required. Before release, smoke-test
any enabled CareLink/Dexcom/LibreLinkUp integration against its real provider;
local fixtures cannot certify provider-specific authentication changes.

References: [Axios 0.32](https://github.com/axios/axios/releases/tag/v0.32.0),
[Axios 0.33](https://github.com/axios/axios/releases/tag/v0.33.0),
[Axios 1.20](https://github.com/axios/axios/releases/tag/v1.20.0).
