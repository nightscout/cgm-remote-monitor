# Notification cache teardown (M25 partial)

Historical implementation evidence; the final M25 policy and maintained-library decision are now in [notification-cache-decision.md](notification-cache-decision.md).

The notification service owns receipt and duplicate-suppression caches. Before
this change, teardown left their housekeeping timers and retained values alive.
An in-flight provider callback could also parse a response or populate a cache
after its service had shut down.

Teardown now marks the service closed, clears and closes both real NodeCache
instances, and detaches its notification listener. Repeated teardown is harmless.
Closed services ignore sends, acknowledgements and provider completions. This is
shutdown behavior only: active-service TTLs, duplicate suppression, receipt
acknowledgement/snooze semantics and provider delivery are preserved.

Two repeated-lifecycle regressions verify cached values and tracked housekeeping
timers return to zero, listeners detach, closed services cannot send again, and
late provider responses are neither parsed nor retained. The existing active
cache and notification contracts remain covered. All 12 combined notification
and cache cases pass on Node 22.23.2 and 24.20.0; local focused runs use the
matching installed dependencies from the native-tooltip validation worktree.
The two new regressions fail against the original implementation. Hosted CI uses
clean installs and remains required before integration.

No real provider receives notifications during these tests. No dependency is
removed and no typical-instance RSS saving is claimed. Cache bounds, clone
policy and the final cache-library retain/replace decision remain open in M25.
