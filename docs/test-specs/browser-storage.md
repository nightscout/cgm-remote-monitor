# Browser storage migration (M16, completed)

The adapter in `lib/client/storage.js` replaces js-storage 1.1.0 for application callers and the shared `window.Storage` export. It uses native local/session storage. Nightscout does not load the optional `Cookies` global used by the old library's cookie fallback; this migration does not add cookies or another persistence backend.

## Persisted data and public operations

Strings remain raw in storage, including `apisecrethash` read directly by the clock. Objects and arrays written with the single-key API remain JSON. Reads parse valid JSON and return raw text on parse failure. Missing values return null. The legacy bulk-object setter's array-to-string behavior is retained, as are explicit JSON mode and dotted/variadic nested paths. This avoids a silent format migration or clearing saved settings.

The public adapter retains localStorage/sessionStorage get, set, remove, keys, isSet, isEmpty and removeAll; namespaceStorages, initNamespaceStorage, removeAllStorages and alwaysUseJsonInStorage remain available. Private library implementation fields and the standalone UMD loader are not application API. Nested traversal uses own properties so inherited prototype objects are not mutation targets.

Initial unavailable or zero-quota storage returns null through the adapter. The availability probe preserves any existing value at its temporary key. Storage failures after initialization still propagate; writes are not falsely reported as persistent and no unbounded memory fallback is introduced. Local and session data stay separate.

## Validation

`tests/browser/storage-contract.test.js` runs in every existing browser CI job. Twelve cases cover persisted formats, clock-compatible raw token writes, repeated removal, special/dotted keys, local/session isolation, denied access and zero quota, bulk/nested/select operations, JSON mode and namespaces/clearing. The same twelve cases pass against the original library and the adapter in Chromium. To repeat the characterization against an installed parent without adding js-storage back to this branch:

```sh
NIGHTSCOUT_STORAGE_ORACLE=/path/to/parent/node_modules/js-storage/js.storage.js npm run test:browser -- --grep 'Browser storage persisted-data contract'
```

Normal CI leaves that variable unset and exercises the checked-in adapter. Full application browser coverage includes saved settings, authentication, report preferences, Care Portal and clock initialization. The reportstorage Node unit tests retain their isolated mocked storage object. Full backend, client-core, browser and hosted validation must pass before merging the child PR.

## Size and scope

The expanded compatibility adapter removes one lockfile package entry and changes no retained entries. Against the clean tree-equivalent parent at `6e11941a`, production app and clock each shrink by 1,455 raw bytes. With Node 22.23.2 gzip level 9, app changes from 402,808 to 402,787 bytes and clock from 61,784 to 61,426. The small compressed savings reflect the cost of retaining the public API; the earlier narrow prototype's larger savings are superseded. Clock imports storage indirectly through browser-settings.

After incorporating M15 (`378a33e9`) without conflicts, the shared app is 1,153,108 raw bytes / 331,946 Node gzip bytes, compared with 1,154,563 / 332,151 in the parent. Clock is 150,676 / 61,426, compared with 152,131 / 61,784. All application entries total 404,994 gzip bytes versus 405,201 (207 fewer); clock is separate. Existing M15 bundle/heap/startup budgets remain unchanged. The combined implementation is undergoing fresh validation. No server RSS saving is established. Rollback restores the manifest/lock entry and caller imports together; the persisted browser format remains readable by the previous release.

## Final integration validation

Merged in #8636 as `06e986bb`. All eight backend jobs, six browser jobs, npm 12, CodeQL and both Docker architectures passed on `b00f5b3b`; the actual merge tree matched the verified tree. Local combined Chromium passed 505 cases. An initial local backend run returned an isolated 401 in a profile test; a diagnostic run passed all 1,616 tests with one existing pending, and 1,000 additional cache/auth requests passed with matching owned-server markers. The initial anomaly remains unexplained, not claimed fixed. No server authorization code changed. Earlier pending-gate notes above describe the intermediate implementation.
