# Owned database upgrade and recovery rehearsal

M29 automated evidence, 2026-09-08. The standalone rehearsal exercises MongoDB
5.0.32 → 6.0.27 → 7.0.40 → 8.0.29 using one disposable data volume, checking the
application before and after each feature compatibility version (FCV) change.
It then restores the original MongoDB 5 backup to a fresh MongoDB 5 volume and
the final MongoDB 8 backup to a fresh MongoDB 8 volume. Both recovery targets
must pass the same application and BSON/index comparisons.

This follows the successive-major/FCV requirements in MongoDB's
[archived 6.0 procedure](https://github.com/mongodb/docs/blob/v6.0/source/release-notes/6.0-upgrade-standalone.txt),
[7.0 procedure](https://www.mongodb.com/docs/v7.0/release-notes/7.0-upgrade-standalone/)
and [8.0 procedure](https://www.mongodb.com/docs/v8.0/release-notes/8.0-upgrade-standalone/).
The recovery test restores backups into fresh storage; it does not run old
binaries against upgraded data or promise that changing an image tag undoes
FCV changes. In particular, MongoDB documents restrictions on binary downgrade
from 7.0 onward. Application rollback and database recovery remain separate.

## What is verified

The fixture uses authenticated MongoDB and the actual Nightscout server on an
ephemeral loopback port. All API requests use the fixture API-secret hash.
Each stage requires a loaded runtime, authenticated reads of three glucose
entries, three treatments, the stored New York profile, and an authenticated
treatment upload verified in storage. Historical reads use explicit date
filters so they exercise database-backed reads rather than the recent cache.
The upload probe is removed before the unchanged-data comparison.

Six collections retain exactly their BSON data and indexes: entries, treatments,
profile, devicestatus, food and settings. The synthetic records include ObjectId
and UUID string IDs, identifier/null/syncIdentifier patterns resembling Loop,
Trio and AAPS uploads, nested data, BSON dates, a DST-boundary timestamp, profile
timezone/units and explicit indexes. These are storage/identity fixtures, not
a claim that a real device uploaded data during the rehearsal. Existing full
API/client identity and replica-failover CI provide complementary coverage.

`mongodump --archive` runs after the verified stages. Archive size/hash, image
digests, actual server/FCV versions, collection hashes/counts and indexes are
recorded in [the local evidence](../audits/database-upgrade-recovery.json).
Both actual Node floors, 22.23.2 and 24.20.0, passed locally against the built/pruned integration graph at 3715f931 on Docker arm64.
Each run removed its six owned containers and three owned volumes afterward.
The source hashes and runtime are recorded separately from measurements. Metadata distinguishes the committed lock from the post-prune lock; pruning can omit the optional development js-yaml peer record without changing the submitted manifest.

The existing Node 24/MongoDB 8 hosted job repeats the rehearsal after building
and pruning Nightscout, then uploads `database-upgrade-recovery`. This also
checks that the worker uses production dependencies and surviving assets.
Current-head hosted evidence must pass before integrating this child PR.

## Scope and reproduction

```sh
python3 tools/rehearse-database-upgrade.py /tmp/new-owned-upgrade-output \
  --node /path/to/supported/node
```

Use a clean built checkout and a local Docker engine. The output directory must
be new. The harness accepts no deployment URI or existing resource names: it
creates UUID-named, labeled containers/volumes and a synthetic database, binds
only ephemeral loopback ports, and removes only resources it created. A failed
verification stops later stages; cleanup failures fail the run. Synthetic
archives and diagnostics remain in the chosen output directory.

This is a small standalone upgrade/restore rehearsal. It does not validate a
production backup's consistency, a long-running burn-in, large database timing,
real Atlas IAM credentials, or topology-specific replica/sharded upgrades.
MongoDB 5/6 remain supported during migration; no further retirement is made.
The maintainer owns deployment and real-account/device validation after the
automated modernization work, as recorded in the main plan. No manual gate is
marked passed and no deployment data is changed.

Rollback of this child removes only the rehearsal, CI step and documentation;
there is no Nightscout schema or production configuration migration.
