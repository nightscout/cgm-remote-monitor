# Notification receipt payload

Pushover receipt acknowledgements need only level, group and eventName.
The actual settings snooze selector reads eventName/level; notifications.ack
receives level/group. Cache those fields instead of cloning the complete
notification, including message data and plugin objects/functions.

The send payload is unchanged. node-cache still clones the receipt snapshot
and preserves its one-hour TTL, periodic cleanup, get/delete and cancellation
behavior. This slice does not introduce eviction of outstanding receipts,
change notification deduplication, or remove node-cache. Broader bounded-cache
and maintained-library decisions remain open under M25.

Seven focused cache tests pass on Node 22.23.2 and 24.20.0. Six also pass on
the previous implementation; the retained-field assertion fails there. Tests
cover high/low urgent/warning and plugin snooze selection using real settings,
mutation after sending, repeated acknowledgement, receipt expiry twice,
send-success TTL extension, failure retry suppression and cancellation retry.

The retention improvement is structural: message/plugin/extra fields are
absent from cached receipts. No whole-server RAM reduction is claimed without
representative measurements. Full backend and hosted gates remain required.
No persisted data, UI or configuration changes. Rollback restores the former
full-notification receipt value; receipt caches are process-local and expire.
