# Historical D6 change-feed transport

The custom pgoutput reader and hint-listener reconciliation transport are
retired. Product evaluator input now uses maintained pgstream and committed
clock/settings/policy/activity/lifecycle events. Realtime reads durable completed
evaluator output; it does not repeat the raw-input discovery pipeline.

The existing safety contract remains: a clinical write commits independently of
notification delivery, and tenant authority is checked at the operation that
uses it. Confirmed evaluator completion commits durable delivery state before
waking the output consumer; wake loss is recovered from that state. A wake is
not a clinical result, permission grant, or proof of client delivery.

The historical [catalogue](../lib/change-feed/postgres-candidate.json) is retained
unchanged for old migration ledgers and backup recognition. It is not a deployable
reader recipe. Historical captures remain attributed to their recorded source,
configuration and transport and do not qualify the maintained replacement.

Current runtime responsibilities are implemented in
[`lib/pgstream/evaluator.js`](../lib/pgstream/evaluator.js),
[`lib/pgstream/activity-scheduler.js`](../lib/pgstream/activity-scheduler.js) and
[`lib/pgstream/realtime-output.js`](../lib/pgstream/realtime-output.js).
