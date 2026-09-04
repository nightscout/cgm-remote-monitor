# Alarm Snooze Schema Documentation

**Document Version:** 1.0
**Last Updated:** May 2026
**Status:** Active
**Source:** Code analysis (`lib/storage/alarmStorage.js`, `lib/notifications.js`)

---

## Overview

The `alarmsnooze` collection stores per-(level, group) alarm snooze state so that an ack on one cgm-remote-monitor instance is honored by other instances. Without this, multi-instance deploys (Cloud Run, k8s, Heroku scale-out) re-emit alarms that the user has already acked, because the legacy `var alarms = {}` map at `lib/notifications.js` is process-local.

**Collection Name:** `alarmsnooze`
**Primary Key:** `_id = level + '-' + group` (string composite)
**TTL:** Mongo TTL monitor cleans expired docs based on `expiresAt`

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | String | Yes | Composite key `level-group` (e.g. `2-default`, `1-treatments`) |
| `level` | Number | Yes | Alarm level (1=WARN, 2=URGENT) |
| `group` | String | Yes | Alarm group (defaults to `'default'`) |
| `lastAckTime` | Number | Yes | Epoch ms when the most recent winning ack was applied |
| `silenceTime` | Number | Yes | Snooze duration in ms (default 30 min if not specified by client) |
| `expiresAt` | Date | Yes | `lastAckTime + silenceTime` as a Date; TTL field |

---

## Indexes

| Index | Type | Purpose |
|-------|------|---------|
| `_id_` | Auto-unique | MongoDB default; supports lookup by composite key |
| `expiresAt_1` | TTL (`expireAfterSeconds: 0`) | Auto-cleanup of expired snoozes |

---

## Write Semantics

`alarmStorage.setSnooze(level, group, lastAckTime, silenceTime)` performs a conditional upsert via aggregation pipeline. The pipeline only overwrites `lastAckTime`, `silenceTime`, and `expiresAt` when the new `expiresAt` is strictly later than the existing one. This prevents a shorter snooze on instance A from clobbering a longer snooze that instance B is honoring.

```javascript
db.alarmsnooze.updateOne(
  { _id: '2-default' },
  [{ $set: {
    level: 2,
    group: 'default',
    lastAckTime: { $cond: [winner, newAck, '$lastAckTime'] },
    silenceTime: { $cond: [winner, newSilence, '$silenceTime'] },
    expiresAt:   { $cond: [winner, newExpiresAt, '$expiresAt'] }
  }}],
  { upsert: true }
)
```

Where `winner = { $gt: [newExpiresAt, { $ifNull: ['$expiresAt', new Date(0)] }] }`.

---

## Read Semantics

`alarmStorage.getSnooze(level, group)` reads only unexpired docs by filtering `expiresAt: { $gt: new Date() }`. This guards against the up-to-60s lag between expiry and TTL sweep.

---

## Fallback Behavior

If `ctx.store` is unavailable (Mongo down at boot, or the operator runs in a degraded mode), `alarmStorage` methods are no-ops that resolve to `null`. `notifications.js` falls back to in-memory-only behavior, matching pre-fix semantics. Single-instance deploys without Mongo connectivity continue to work.

---

## Compatibility

Aggregation-pipeline updates (`updateOne` with a `[{$set: ...}]` array) require MongoDB 4.2 or later. Verified locally against MongoDB 4.4, 5.0, and 6.0 with Node 20.

## Related

- [`lib/notifications.js`](../../lib/notifications.js) -- consumes `alarmStorage` for ack write-through and first-emit-per-process refresh
- [`lib/server/bootevent.js`](../../lib/server/bootevent.js) -- wires `ctx.alarmStorage` and creates the TTL index
- nightscout/cgm-remote-monitor#8194 -- original issue
