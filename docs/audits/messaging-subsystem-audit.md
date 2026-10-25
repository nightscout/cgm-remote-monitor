# Messaging Subsystem Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** Pushover, IFTTT Maker, notification flows, deduplication, acknowledgment flows

---

## 1. Executive Summary

The Nightscout messaging subsystem enables critical alerts to reach caregivers through multiple channels. This audit examines notification generation, delivery mechanisms, and reliability considerations.

### Messaging Overview

| Component | Purpose | Status |
|-----------|---------|--------|
| Internal Notifications | Alarm management | Core |
| Pushover | Push notifications | Integration |
| IFTTT Maker | Webhook automation | Integration |
| Apple Push (APN) | iOS notifications | Optional |
| WebSocket Alerts | Browser notifications | Core |

---

## 2. Notification Architecture

### 2.1 Notification Flow

```
Plugin checks data
        ↓
requestNotify() or requestSnooze()
        ↓
Notification Manager (lib/notifications.js)
        ↓
Process notifications
        ↓
emit('notification', notify)
        ↓
┌───────────────────────────────────────────┐
│                 Event Bus                  │
└───────┬─────────────┬─────────────────────┘
        │             │
        ▼             ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  Pushover   │ │   Maker     │ │  WebSocket  │
│  Plugin     │ │   Plugin    │ │  Broadcast  │
└─────────────┘ └─────────────┘ └─────────────┘
```

### 2.2 Notification Object

```javascript
{
  level: 1,                    // 0=INFO, 1=WARN, 2=URGENT
  title: 'Low Glucose',        // Short title
  message: 'BG is 65 mg/dL',   // Detailed message
  plugin: plugin,              // Source plugin reference
  group: 'default',            // Notification group
  isAnnouncement: false,       // Is user announcement
  
  // Optional fields
  clear: false,                // Is clear notification
  debug: {},                   // Debug information
  pushoverSound: 'climb',      // Custom sound
  
  // Computed
  notifyhash: 'abc123'         // Deduplication hash
}
```

### 2.3 Notification Levels

| Level | Name | Constant | Use Case |
|-------|------|----------|----------|
| -2 | None | `NONE` | Internal only |
| -1 | Low | `LOW` | Debug/trace |
| 0 | Info | `INFO` | Informational |
| 1 | Warning | `WARN` | Attention needed |
| 2 | Urgent | `URGENT` | Immediate action |

---

## 3. Notification Manager

### 3.1 Core Implementation

**Location:** `lib/notifications.js`

**Key Functions:**

```javascript
// Request a notification
notifications.requestNotify = function(notify) {
  if (!notify.level || !notify.title || !notify.message || !notify.plugin) {
    console.error('Incomplete notification');
    return;
  }
  notify.group = notify.group || 'default';
  requests.notifies.push(notify);
};

// Request a snooze
notifications.requestSnooze = function(snooze) {
  snooze.group = snooze.group || 'default';
  requests.snoozes.push(snooze);
};

// Process all pending notifications
notifications.process = function() {
  // Find highest alarm per group
  // Check for snoozing
  // Emit or suppress
};
```

### 3.2 Alarm Management

**Alarm Object:**
```javascript
var Alarm = function(level, group, label) {
  this.level = level;
  this.group = group;
  this.label = label;
  this.silenceTime = 30 * 60 * 1000;  // 30 minutes default
  this.lastAckTime = 0;
  this.lastEmitTime = null;
};
```

**Alarm Processing:**
1. Collect all requested notifications
2. Group by notification group
3. Find highest priority per group
4. Check if snoozed by any snooze request
5. Check if silenced from previous ack
6. Emit if not suppressed

### 3.3 Auto-Acknowledgment

When conditions return to normal:
```javascript
function autoAckAlarms(group) {
  for (var level = 1; level <= 2; level++) {
    var alarm = getAlarm(level, group);
    if (alarm.lastEmitTime) {
      notifications.ack(alarm.level, group, 1);  // 1ms silence
      sendClear = true;
    }
  }
  
  if (sendClear) {
    ctx.bus.emit('notification', {
      clear: true,
      title: 'All Clear',
      message: 'Auto ack\'d alarm(s)',
      group: group
    });
  }
}
```

---

## 4. Push Notification Orchestrator

### 4.1 Implementation

**Location:** `lib/server/pushnotify.js`

```javascript
function init(env, ctx) {
  var receipts = new NodeCache({ stdTTL: 3600 });
  var recentlySent = new NodeCache({ stdTTL: 900 });
  
  pushnotify.emitNotification = function(notify) {
    if (notify.clear) {
      cancelPushoverNotifications();
      sendMakerAllClear(notify);
      return;
    }
    
    // Check deduplication
    var key = notify.notifyhash || generateHash(notify);
    if (recentlySent.get(key)) {
      console.log('Skipping duplicate notification');
      return;
    }
    
    // Send to providers
    ctx.pushover.send(notify, callback);
    ctx.maker.sendEvent(notify, callback);
  };
}
```

### 4.2 Deduplication

**Strategy:**
- Generate hash from notification content
- Cache recently sent hashes (15 minute TTL)
- Skip if hash exists in cache

**Hash Generation:**
```javascript
function generateHash(notify) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1');
  hash.update(notify.title + notify.message);
  return hash.digest('hex').substring(0, 16);
}
```

### 4.3 Receipt Tracking (Pushover)

For emergency priority notifications:
```javascript
var receipts = new NodeCache({ stdTTL: 3600 });

// Store receipt from Pushover
receipts.set(receipt, notify);

// Periodic check
pushnotify.checkReceipts = function() {
  receipts.keys().forEach(function(receipt) {
    ctx.pushover.checkReceipt(receipt, function(err, result) {
      if (result.acknowledged) {
        // User acknowledged, remove from cache
        receipts.del(receipt);
      }
    });
  });
};
```

---

## 5. Pushover Integration

### 5.1 Configuration

**Location:** `lib/plugins/pushover.js`

**Environment Variables:**
```
PUSHOVER_API_TOKEN=your-app-token
PUSHOVER_USER_KEY=user-or-group-key
PUSHOVER_ALARM_KEY=key-for-alarms
PUSHOVER_ANNOUNCEMENT_KEY=key-for-announcements
BASE_URL=https://nightscout.example.com
```

### 5.2 Key Management

```javascript
var pushoverAPI = {
  userKeys: env.extendedSettings.pushover.userKey.split(' '),
  alarmKeys: (env.extendedSettings.pushover.alarmKey || userKey).split(' '),
  announcementKeys: (env.extendedSettings.pushover.announcementKey || userKey).split(' '),
  apiToken: env.extendedSettings.pushover.apiToken
};

function selectKeys(notify) {
  if (notify.isAnnouncement) {
    return pushoverAPI.announcementKeys;
  } else if (ctx.levels.isAlarm(notify.level)) {
    return pushoverAPI.alarmKeys;
  }
  return pushoverAPI.userKeys;
}
```

### 5.3 Priority Mapping

| Nightscout Level | Pushover Priority | Behavior |
|------------------|-------------------|----------|
| INFO | 0 (Normal) | Normal push |
| WARN | 1 (High) | Bypasses quiet hours |
| URGENT | 2 (Emergency) | Repeats until ack'd |

### 5.4 Message Sending

```javascript
pushover.send = function(notify, callback) {
  var selectedKeys = selectKeys(notify);
  
  selectedKeys.forEach(function(userKey) {
    var msg = {
      message: notify.message,
      title: notify.title,
      priority: mapPriority(notify.level),
      sound: notify.pushoverSound || 'gamelan',
      callback: env.base_url + '/api/v1/notifications/pushovercallback',
      timestamp: Math.round(Date.now() / 1000)
    };
    
    if (msg.priority === 2) {
      msg.retry = 120;    // Retry every 2 minutes
      msg.expire = 3600;  // Expire after 1 hour
    }
    
    pushoverClient.send(msg, userKey, callback);
  });
};
```

### 5.5 Callback Handling

**Endpoint:** `POST /api/v1/notifications/pushovercallback`

```javascript
api.post('/notifications/pushovercallback', function(req, res) {
  if (ctx.pushnotify.pushoverAck(req.body)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(500);
  }
});
```

---

## 6. IFTTT Maker Integration

### 6.1 Configuration

**Location:** `lib/plugins/maker.js`

**Environment Variables:**
```
MAKER_KEY=your-ifttt-webhooks-key
MAKER_ANNOUNCEMENT_KEY=optional-separate-key
```

### 6.2 Event Types

| Event Name | Trigger | Value1 | Value2 | Value3 |
|------------|---------|--------|--------|--------|
| `ns-event` | Any event | Title | Message | Timestamp |
| `ns-allclear` | Alarm cleared | Title | Message | - |
| `ns-info` | INFO level | Title | Message | - |
| `ns-warning` | WARN level | Title | Message | - |
| `ns-urgent` | URGENT level | Title | Message | - |
| `ns-{plugin}` | Plugin event | Title | Message | - |
| `ns-{level}-{eventName}` | Specific event | Title | Message | - |

### 6.3 Event Sending

```javascript
maker.sendEvent = function(notify, callback) {
  if (!keys || keys.length === 0) return callback();
  
  var events = [
    'ns-event',
    'ns-' + levelName(notify.level),
    'ns-' + notify.plugin.name
  ];
  
  if (notify.eventName) {
    events.push('ns-' + levelName(notify.level) + '-' + notify.eventName);
  }
  
  events.forEach(function(event) {
    keys.forEach(function(key) {
      var url = 'https://maker.ifttt.com/trigger/' + event + '/with/key/' + key;
      
      request.post({
        url: url,
        json: {
          value1: notify.title,
          value2: notify.message,
          value3: Date.now()
        }
      }, callback);
    });
  });
};
```

### 6.4 All Clear Event

```javascript
maker.sendAllClear = function(notify, callback) {
  if (Date.now() - lastAllClear > 30 * 60 * 1000) {
    lastAllClear = Date.now();
    
    var key = keys[0];
    var url = 'https://maker.ifttt.com/trigger/ns-allclear/with/key/' + key;
    
    request.post({
      url: url,
      json: {
        value1: notify.title,
        value2: notify.message
      }
    }, callback);
  }
};
```

---

## 7. WebSocket Notification Delivery

### 7.1 Browser Notifications

**Location:** `lib/server/websocket.js`, `lib/api3/alarmSocket.js`

**Broadcast Flow:**
```javascript
ctx.bus.on('notification', function(notify) {
  var event = mapLevelToEvent(notify.level);
  
  if (notify.isAnnouncement) {
    io.emit('announcement', notify);
  } else if (notify.clear) {
    io.emit('clear_alarm', {});
  } else {
    io.emit(event, notify);  // 'alarm' or 'urgent_alarm'
  }
});
```

### 7.2 Client-Side Handling

```javascript
socket.on('alarm', function(alarm) {
  // Show notification
  showDesktopNotification(alarm);
  
  // Play sound
  playAlarmSound(alarm.level);
  
  // Update UI
  showAlarmModal(alarm);
});

socket.on('urgent_alarm', function(alarm) {
  // More aggressive notification
  showUrgentNotification(alarm);
  playUrgentSound();
});

socket.on('clear_alarm', function() {
  // Dismiss notifications
  hideAlarmModal();
  stopAlarmSound();
});
```

### 7.3 Desktop Notifications

```javascript
function showDesktopNotification(alarm) {
  if (Notification.permission === 'granted') {
    new Notification(alarm.title, {
      body: alarm.message,
      icon: '/images/logo.png',
      tag: 'nightscout-alarm-' + alarm.level,
      requireInteraction: true
    });
  }
}
```

---

## 8. Acknowledgment Flow

### 8.1 Acknowledgment Sources

| Source | Method | Scope |
|--------|--------|-------|
| Web UI | WebSocket `ack` | Local + server |
| Pushover | Callback POST | Server + cancel loop |
| API | GET /notifications/ack | Server |

### 8.2 Web Acknowledgment

```javascript
// Client sends ack
socket.emit('ack', level, group, silenceTime);

// Server handles
socket.on('ack', function(level, group, silenceTime) {
  ctx.notifications.ack(level, group, silenceTime);
  
  // Broadcast clear to all clients
  ctx.bus.emit('notification', {
    clear: true,
    title: 'All Clear',
    message: 'Alarm acknowledged',
    group: group
  });
});
```

### 8.3 API Acknowledgment

**Endpoint:** `GET /api/v1/notifications/ack`

**Parameters:**
- `level` - Alarm level (1 or 2)
- `group` - Notification group
- `time` - Silence duration (ms)

```javascript
api.get('/notifications/ack', 
  ctx.authorization.isPermitted('notifications:*:ack'),
  function(req, res) {
    var level = Number(req.query.level);
    var group = req.query.group || 'default';
    var time = Number(req.query.time) || 1800000;  // 30 min default
    
    ctx.notifications.ack(level, group, time);
    res.sendStatus(200);
  }
);
```

### 8.4 Silence Duration

| Method | Default Duration | Configurable |
|--------|-----------------|--------------|
| Web UI | 30 minutes | Yes (button presets) |
| Pushover | Until expired | Implicit |
| API | 30 minutes | Yes (query param) |

---

## 9. Reliability Considerations

### 9.1 Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Pushover API down | No push notifications | Retry logic, alternative channel |
| IFTTT unavailable | No webhook events | Silent failure (acceptable) |
| Network partition | Delayed notifications | Queue locally, retry |
| Server crash | Lost in-memory state | Events reconstructed on reload |

### 9.2 Retry Logic

**Current State:** Limited retry for Pushover, none for Maker

**Recommendation:**
```javascript
async function sendWithRetry(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await sleep(delay * Math.pow(2, i));
    }
  }
}
```

### 9.3 Queue Persistence

**Current State:** In-memory only

**Recommendation:**
- Add Redis queue for pending notifications
- Survive server restarts
- Enable horizontal scaling

---

## 10. Monitoring and Logging

### 10.1 Current Logging

```javascript
console.info('EMITTING ALARM:', JSON.stringify(notify));
console.log('Skipping duplicate notification');
console.error('Pushover send failed:', err);
```

### 10.2 Recommended Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `notifications_emitted_total` | Counter | Total by level |
| `notifications_acknowledged_total` | Counter | Ack rate |
| `pushover_send_duration_ms` | Histogram | Latency |
| `pushover_failures_total` | Counter | Error rate |
| `maker_events_sent_total` | Counter | Volume |

### 10.3 Alerting Recommendations

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Pushover failure rate | >10% in 5min | Alert ops |
| Notification latency | >30s p99 | Warn |
| Queue depth | >100 | Scale |

---

## 11. Issues and Recommendations

### 11.1 Critical Issues

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| No message queue | Lost notifications on crash | Add Redis queue |
| Deprecated `request` library | Security risk | Migrate to axios |
| No retry logic for IFTTT | Silent failures | Add retry with backoff |

### 11.2 Improvements

| Area | Current | Recommended |
|------|---------|-------------|
| Dedup window | 15 minutes | Configurable |
| Retry strategy | None | Exponential backoff |
| Failure logging | Basic | Structured logging |
| Rate limiting | None | Per-channel limits |

### 11.3 Additional Channels

Consider adding support for:

1. **Twilio SMS:**
   - Critical for non-smartphone users
   - Reliable delivery

2. **Email:**
   - Summary/digest notifications
   - Non-critical alerts

3. **Slack/Discord:**
   - Team notifications
   - Care team coordination

4. **Apple Push (APN):**
   - Native iOS app support
   - Already has dependency (`@parse/node-apn`)

---

## 12. Security Considerations

### 12.1 Sensitive Data

| Data | Risk | Mitigation |
|------|------|------------|
| API keys | Exposure | Environment variables only |
| User keys | Exposure | Never log full keys |
| Health data in messages | Privacy | Minimal message content |

### 12.2 Callback Security

**Pushover Callback:**
- No signature verification
- Relies on obscure URL
- Consider adding HMAC signature

### 12.3 Rate Limiting

**Current State:** Deduplication only (15 min window)

**Recommendation:**
- Add per-minute rate limits per channel
- Prevent notification storms
- Log rate limit events

---

## 13. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [Plugin Architecture Audit](./plugin-architecture-audit.md)
- [Real-Time Systems Audit](./realtime-systems-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)
