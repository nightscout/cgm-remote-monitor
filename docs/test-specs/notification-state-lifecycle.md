# Notification service state ownership

The alarm/snooze map was stored at module scope, allowing independent service
contexts in one Node process to share snooze state. Pending requests and alarm
state also remained available after that context's teardown. Moving the map
inside service initialization separates ownership; teardown clears both alarm
state and pending notification/snooze requests. Closed services ignore later
requests, processing and acknowledgements.

Two regressions fail against the original implementation. They exercise two
service lifecycles, independent snoozes, pending-request release, repeated
teardown and late requests/acknowledgements. The eight existing notification
cases still pass. Combined notification/push-cache coverage passes 22 cases on
Node 24; changed-file lint passes on Node 22. Full current-base validation remains
required before merge.

Live-service snooze timing, urgent-to-warning acknowledgements, provider receipt
TTLs and deduplication policy are unchanged. No package is removed and no
steady-state RAM saving is claimed. This does not establish a hard bound for
active-service alarm groups or complete M25's notification-cache policy decision.
