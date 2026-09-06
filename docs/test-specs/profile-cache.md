# Bounded profile reference cache

M25's first implementation replaces memory-cache only in profilefunctions.
The application uses get/put/clear with a five-second lifetime and reference
values. Nine characterization cases pass against the old cache and the local
implementation: misses/zero/false/null, reference mutation, normal and delayed
expiry, replacement lifetime, clock changes, two reset cycles and instance/key isolation.
A tenth case verifies capacity eviction, replacement order and one pending
timer. The new helper retains at most 524,288 computed values per instance and
uses one unreferenced Node timer (ordinary browser timer), not one timer per
entry. Clearing a profile clears entries and its timer. Values above capacity
are evicted oldest-write-first and recomputed by the existing profile methods.

The capacity follows workload measurements, not a claimed universal zero-cost
limit. An initial 4,096 cap thrashed on a daily minute-resolution workload;
16,384 preserved a day but repeatedly missed across fourteen days. The final
cap accommodates the measured 31-day working set. Longer/larger working sets
can evict and recompute entries; this is the explicit bounded-memory trade-off.

Run tools/measure-profile-cache-workload.js with --expose-gc and a reference
checkout path plus day count. Each fresh process executes two sweeps through
six real profile lookups per minute, then reports retained heap after GC.
Seven alternating old/new pairs for 1, 14 and 31 days have identical totals.
[Raw samples](../audits/profile-cache-workload.json) record Node 22.23.2 runs.
Median old/new retained bytes and first/warm sweep milliseconds:

- 1 days: 6,743,040/2,703,840 bytes; first 34.13/29.65 ms; warm 1.44/1.77 ms.

- 14 days: 83,234,824/32,661,472 bytes; first 312.19/289.21 ms; warm 27.13/28.20 ms.

- 31 days: 195,105,864/70,165,384 bytes; first 730.60/636.84 ms; warm 82.42/70.43 ms.

These are isolated populated-profile measurements, not whole-server RSS,
production traffic guarantees or a promise about every possible date range.

Notification caches remain node-cache in this slice. Receipt payloads include
plugin objects/functions, so structuredClone is not a compatible replacement.
The recently-sent cache already stores boolean markers; receipt/dedup TTL,
clone and acknowledgement semantics need their own review before changing it.
M25 remains open for that decision and complete combined validation.

Existing profile tests pass on Node 22/24. Full backend, browser/DST/profile
switching and hosted checks remain required. Rollback restores memory-cache
and the profilefunctions import together; no persisted profile data changes.

Clock regression review: the initial candidate used wall time for timer
scheduling and retained values too long after a backward system-clock jump.
New backward/forward clock tests pass on the legacy cache and exposed that
candidate failure. Timer deadlines now use performance.now, while reads retain
the legacy wall-clock expiry check. All ten cache contracts pass on both Node
floors. Workload samples above were rerun with this corrected implementation.
