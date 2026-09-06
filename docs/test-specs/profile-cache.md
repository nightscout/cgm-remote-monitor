# Bounded profile reference cache

M25's first implementation replaces memory-cache only in profilefunctions.
The application uses get/put/clear with a five-second lifetime and reference
values. Seven characterization cases pass against the old cache and the local
implementation: misses/zero/false/null, reference mutation, normal and delayed
expiry, replacement lifetime, two reset cycles and instance/key isolation.
An eighth case verifies capacity eviction, replacement order and one pending
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
Median retained heap old/new: 6,745,336/2,415,312 bytes (day),
83,236,152/28,788,088 (14 days), 195,103,696/61,587,568 (31 days).
Median first/warm sweep milliseconds old/new: 34.01/28.64 and 1.48/1.62 (day),
310.36/276.53 and 27.05/27.73 (14 days), 726.29/620.31 and 83.69/68.98 (month).
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
