# M25 cache decision

Decision, 2026-09-08: keep the bounded reference cache for computed profile
values and migrate notification state from node-cache 4.2.1 to the maintained
@cacheable/node-cache 3.1.1 with a small application compatibility adapter.
Do not combine these caches: evicting a profile value permits recomputation;
evicting a live receipt loses acknowledgement/cancellation state, and evicting
a live suppression marker permits a duplicate alarm. A shared local helper
would need separate eviction, snapshot and timer policies for these contracts.
This selects M25's maintained-library alternative.

The profile cache retains its 524,288-entry cap, five-second expiry, reference
semantics, profile-switch clearing and single timer. Its existing ten contracts
pass on both exact Node floors; the earlier [profile workload evidence](profile-cache.md)
remains scoped to that unchanged implementation.

Notification state has a **TTL bound, not a hard cardinality bound**. Receipt
snapshots retain only level/group/eventName for one hour, swept every five
minutes. Boolean suppression markers begin at 30 seconds and successful sends
extend a still-live key to 15 minutes, swept every 20 seconds. Reads reject
expired values even if housekeeping is delayed. A burst of distinct keys can
still consume memory proportional to traffic in those windows; no universal
memory ceiling or production traffic guarantee is claimed. Neither silent
eviction nor the maintained library's throwing `maxKeys` limit is enabled:
both would change delivery/acknowledgement behavior. A hard delivery-state cap
would require a separate persistent-state or explicit overload policy.

## Compatibility and dependency review

The [maintained package documentation](https://cacheable.org/docs/node-cache/)
describes its API and capacity option. Inspection and executable comparison of
the pinned code found five differences from Nightscout's legacy contract:
copy-on-write, extension of expired unread keys, stored undefined, zero-TTL
extension and negative-TTL deletion. `lib/utils/notification-cache.js` preserves
those semantics. The adapter is scoped to booleans and owned serializable
receipts, not an arbitrary replacement for every legacy cache method or plugin
object graph. Copy-on-read remains provided by the maintained cache.

Ten cache characterization cases pass against both the original package and
the adapter; five fail against the raw maintained class. They include repeated
unread background expiry, exact expiry boundaries, clone/reference behavior,
null/zero/undefined, extension, instance isolation and clear cycles. Together
with actual pushnotify, provider and profile tests, 47 cases pass on Node
22.23.2 and 24.20.0. Existing delayed multi-recipient callbacks, reused payloads,
failure retry, snooze selection, cancellation retry and repeated teardown
remain covered. Teardown releases both cache timers and all retained values;
late provider completions cannot repopulate them.

The new library supports Node >=22 and provides a CommonJS export. Keyv 5.6.0,
@cacheable/utils 2.5.0 and their existing transitive packages now participate in
the production graph; hookified 2.2.0 is scoped under the new package so the
older hashery consumer keeps its compatible version. No retained lockfile
package changes version. node-cache and clone are removed. Lodash 4.18.1 is
now an explicit dependency because `lib/utils.js` already imports
`lodash/escape`; relying on the removed cache's transitive declaration would
break a clean browser build. Its version and escaping behavior are unchanged.
The unchanged optional js-yaml peer record is preserved for Docker's install
without the source checkout's .npmrc.

## Repeated notification workload

`tools/audits/notification-cache-cycles.py` runs seven alternating fresh-process
pairs per supplied Node executable. Each process calls real pushnotify with
local provider fakes, a controlled clock, and five cycles of 1,000 distinct
payloads plus 5,000 duplicate emissions. Each cycle acknowledges half the
receipts, cancels the remainder, then expires the unread markers. Assertions
verify all 5,000 sends, 25,000 suppressed duplicates, 2,500 acknowledgements,
2,500 cancellations, empty caches after every cycle, two timers while active,
and zero timers/listeners at shutdown. No real notification is sent.

[Raw results and source hashes](../audits/notification-cache-cycles.json) record
the retained parent and proposed implementation. Median bytes after forced GC
and cycle time (35 cycle timings per row):

| Node / implementation | Loaded heap delta | Peak populated delta from loaded | Final released delta from loaded | Cycle ms |
| --- | ---: | ---: | ---: | ---: |
| 22.23.2 / original | 1,093,752 | 637,840 | 372,960 | 8.57 |
| 22.23.2 / maintained | 1,202,888 | 735,128 | 386,208 | 8.15 |
| 24.20.0 / original | 1,287,392 | 627,864 | 352,128 | 8.30 |
| 24.20.0 / maintained | 1,326,928 | 725,816 | 371,440 | 7.85 |

This is an isolated notification-module workload, not whole-server RSS or a
long-running leak guarantee. JIT/module and harness state remains after values
are released. The maintained implementation costs roughly 40–109 KB more
loaded heap and about 98 KB more populated heap here; it is selected for
maintenance with verified behavior, not a memory-saving claim. Do not add
historical profile/receipt savings to these figures. Existing whole-server
probes now use the shared public cache API and accept either marker type.

Reproduce with clean installed reference/candidate checkouts:

```sh
python3 tools/audits/notification-cache-cycles.py BASELINE CANDIDATE results.json \
  --node /path/to/node22 --node /path/to/node24
NOTIFICATION_CACHE_REFERENCE=/path/to/baseline/node_modules/node-cache \
  node_modules/.bin/mocha tests/notification-cache-contract.test.js
```

Local clean install/build, backend suite (2,119 passing plus one existing
pending case), client-core 283,
dependency 305, and lint zero errors/16 existing warnings passed. Hosted CI,
CodeQL, Docker and merge-tree checks remain required before child integration.
Rollback reverts this child dependency/adapter change together; no persisted
data or user configuration changes. Production/device testing remains with
the maintainer after automated branch completion.
