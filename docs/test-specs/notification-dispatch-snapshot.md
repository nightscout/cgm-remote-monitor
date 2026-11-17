# Notification dispatch snapshots

M25 review found that `pushnotify` constructed its reduced receipt record only
when Pushover completed. Mutating the notification during the request could
therefore change the level, group and event used to acknowledge the original
alarm. Likewise, reusing a notification under another key before Pushover or
Maker completed could extend the second key's suppression instead of the first.

Capture the three acknowledgement fields before calling Pushover and pass the
resolved dispatch key to both provider helpers. Each Pushover recipient uses
the same dispatch snapshot; node-cache still clones each stored receipt and
read result. The fields are the application's scalar level/group/event values;
this does not introduce a general deep-clone helper for notification graphs.
The providers still receive the original payload. TTL lengths, retry policy,
cancellation, receipt deletion, teardown and persisted data are unchanged.

Three new tests in `tests/pushnotify-cache.test.js` fail on parent
`bc14aec52bf87de3270fc0418e7448e267aede73`: changed acknowledgement fields,
Pushover extending the wrong key, and Maker extending the wrong key. The tests
exercise two recipient receipts and a successful first request completing after
a failed second request on a reused payload. Existing cancellation, expiry,
snooze-selection and late-callback teardown cases remain active.

Validation commands (from the child checkout, Node 22.23.2 / npm 10.9.8):

```sh
npm ci
node node_modules/mocha/bin/mocha.js tests/pushnotify-cache.test.js tests/pushnotify.test.js tests/notification-state-lifecycle.test.js tests/pushover.test.js tests/maker.test.js --reporter dot
TZ=America/Los_Angeles npm run test-ci
TZ=America/Los_Angeles npm run test:core
npm run test:dependencies
npm run lint
```

The focused suite passes 29 cases on both Node 22.23.2 and 24.20.0. The clean
locked install includes the production build. Full backend validation uses an
owned MongoDB 8.0.29 container; hosted checks cover the other supported MongoDB
versions, browser engines, npm 12, CodeQL and both Docker architectures.
Local backend validation passes 2,101 tests with one existing pending case;
client-core passes 283 and dependency tests pass 305. Lint reports zero errors
and sixteen existing security warnings. Current-head hosted CI and verification
of the merge tree are required before merging.

No package or memory-saving claim is made. M25 remains open: the profile cache
may evict recomputable values, but evicting live notification markers permits
duplicates and evicting receipts loses acknowledgement/cancellation mappings.
A bounded replacement needs an explicit saturation policy and workload evidence;
a generic oldest-entry eviction or a throwing cache limit is insufficient.
The current node-cache dependency remains for that separate decision.

Rollback: `git revert f2611a22` (or revert the child PR's
merge using `git revert -m 1 <merge-commit>`). No configuration/database migration
is needed; restarting clears process-local notification caches as before.
