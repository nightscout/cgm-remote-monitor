# D5 realtime cache/stat discriminator

This no-dependency instrument pins the D5 cache and bounded-reader source blobs.
It writes only its own temporary synthetic JSON files. It compares raw in-place
writes, the actual parsed cache with in-place writes, and atomic publication with
the actual parsed cache. It does not sleep or log inside the critical sequence.
Each retained sample captures before/after dev, inode, size, mtimeNs, ctimeNs,
mode, exact cache key, clock, actual bytes and returned value. Aggregate counts
cover every iteration; captures are bounded to128 per mode and output to1 MiB.
The existing next-call expectation and unchanged-file read assertions are intact.

Run in the exact clean Node24.22.1/old-kernel worker after source verification:

```bash
node tests/fixtures/realtime-cache-stat-probe.js \
  --iterations 1000 --unchanged 50 --out "$NEW_PRIVATE_PROBE_JSON"
```

The source blobs must match the instrument's D5 hashes; a mismatch exits78.
Unknown NS_/NODE_OPTIONS/NODE_PATH ambient settings refuse. Exit0 means no stale
read reproduced in this bounded run, not proof of all filesystems. Exit2 records
stale in-place cache reads. Exit3 records an atomic-publication/control failure.

The authored detector control freezes the first cached value while leaving disk
writes real. It must report stale returned values and exit3; restore normal mode
for the actual source result. Use a fresh output path each time:

```bash
node tests/fixtures/realtime-cache-stat-probe.js --control freeze-cache \
  --iterations 20 --out "$NEW_PRIVATE_CONTROL_JSON"
```

Focused source-runner request (private TEST_ENV_FILE, no --ci; no full campaign):

```bash
node scripts/test-tiers.js run unit tests/realtime-config-cache.test.js
node scripts/test-tiers.js run unit \
  tests/realtime-config-cache.test.js tests/socket-admission-cache.test.js
```

Use the campaign's clean NODE_ENV=test, CI=true, TZ=UTC and private TEST_ENV_FILE.
Record Node/kernel versions, exact source/instrument hashes, statuses and both
streams. Do not copy credentials from the private env into public evidence.
If these pass but the failure remains unexplained, report the bounded result;
do not rerun a full tier or silently change file-publication/authority semantics.
