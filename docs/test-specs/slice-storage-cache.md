# Slice storage cache selection

A `/slice/treatments/type/sgv?count=1` request could return an entries-cache
record when that cache contained enough SGV rows. The same path affected
selected device-status storage. The router selected a storage adapter only
after considering the entries cache, so its type-only fast path ignored the
requested collection. This predates the driver 7 candidate.

The router now resolves storage before cache selection and uses the entries
cache only for the entries adapter. Other selected storages query their own
adapter. Existing entries and unknown-storage fallback behavior is retained.
The permission gates from #8667 are unchanged.

`tests/slice-storage-cache.test.js` uses the actual entries, treatments and
device-status adapters, distinct owned MongoDB collections, real HTTP and
Shiro authorization. Over two updates, populated entries-cache values differ
from database values. Treatment/device-status requests must return the correct
collection's current record and issue exactly one find against that collection;
entries/fallback requests must return the cache record without a database read.
The baseline fails by returning `cached-entries-0` instead of `treatments`.

The new case and two existing selected-storage permission cases pass together
on Node 22.23.2/MongoDB 6 and Node 24.20.0/MongoDB 8. Full backend and hosted
validation remain required. This establishes router selection for the tested
slice queries, not every query operator, clinical meaning of arbitrary type
fields, or all database/cache consistency contracts.

No dependency, schema, persisted identifier or UI change is introduced. No
memory saving is claimed; correctly routed non-entry slices may now perform
a database read where the old code incorrectly answered from entries. Rollback
reverts this change, but restores that known incorrect-source behavior.
