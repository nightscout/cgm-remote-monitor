# Real-Time Systems Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** Socket.IO namespaces, event bus patterns, client subscriptions, latency considerations

---

## 1. Executive Summary

Nightscout's real-time capabilities are critical for timely glucose monitoring alerts. This audit examines the event-driven architecture, WebSocket implementation, and opportunities for improvement.

### Real-Time Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Internal Event Bus | Node.js Stream | Inter-process communication |
| Legacy WebSocket | Socket.IO 4.5 | Client data updates |
| Storage Socket | Socket.IO 4.5 | API v3 CRUD events |
| Alarm Socket | Socket.IO 4.5 | Alert broadcasting |

---

## 2. Internal Event Bus

### 2.1 Architecture

**Location:** `lib/bus.js`

The event bus is a Node.js Stream that provides pub/sub functionality within the server process.

**Implementation:**
```javascript
var Stream = require('stream');

function init (settings) {
  var stream = new Stream;
  stream.readable = true;
  
  // Heartbeat ticker
  busInterval = setInterval(function() {
    stream.emit('tick', ictus());
  }, settings.heartbeat * 1000);
  
  stream.teardown = function () {
    clearInterval(busInterval);
    stream.emit('teardown');
  };
  
  return stream;
}
```

### 2.2 Event Catalog

| Event | Source | Subscribers | Data |
|-------|--------|-------------|------|
| `tick` | Bus (timer) | Data loader | `{ now, beat, interval }` |
| `data-received` | API endpoints | Data loader | (none) |
| `data-loaded` | Data loader | Plugin system | (none) |
| `data-processed` | Plugin system | Runtime state | `sbx` |
| `notification` | Plugins, ack | Push notify, WebSocket | Notification object |
| `admin-notify` | Auth failures | Admin notifier | `{ title, message }` |
| `teardown` | Server shutdown | All cleanup handlers | (none) |
| `storage-socket-create` | API v3 | Storage socket | `{ col, doc }` |
| `storage-socket-update` | API v3 | Storage socket | `{ col, doc }` |
| `storage-socket-delete` | API v3 | Storage socket | `{ col, identifier }` |

### 2.3 Event Flow

```
                     ┌─────────────┐
                     │   Timer     │
                     │ (heartbeat) │
                     └──────┬──────┘
                            │ tick
                            ▼
┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│  API v1/v3   │────▶│   Event     │────▶│  Data       │
│  Endpoints   │data-│    Bus      │data-│  Loader     │
└──────────────┘recv │             │loaded└─────────────┘
                     └──────┬──────┘           │
                            │                   │
        ┌───────────────────┼───────────────────┼────────────────┐
        │                   │                   │                │
        ▼                   ▼                   ▼                ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐  ┌─────────────┐
│   Plugin    │     │  WebSocket  │     │   Push      │  │  Storage    │
│   System    │     │  Broadcast  │     │  Notify     │  │  Socket     │
└─────────────┘     └─────────────┘     └─────────────┘  └─────────────┘
```

### 2.4 Timing Characteristics

| Event Trigger | Typical Interval | Latency |
|--------------|------------------|---------|
| Heartbeat tick | 60 seconds (configurable) | <1ms |
| Data received | On API write | <1ms |
| Data processed | After tick + load | 100-500ms |
| Notification | On plugin alarm | <10ms |

### 2.5 Issues and Recommendations

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| No event typing | Runtime errors | Add TypeScript definitions |
| No event validation | Data corruption | Add schema validation |
| Single-threaded | Scalability | Consider Redis pub/sub |
| No persistence | Lost events on crash | Add event sourcing |
| No replay | Debugging difficulty | Add event logging |

---

## 3. Socket.IO Implementation

### 3.1 Server Setup

**Location:** `lib/server/websocket.js`

**Initialization:**
```javascript
var io = require('socket.io')(server, {
  // Default configuration
  pingTimeout: 60000,
  pingInterval: 25000
});

io.on('connection', function (socket) {
  // Handle connection
});
```

### 3.2 Socket.IO Namespaces

| Namespace | Path | Purpose | Auth Required |
|-----------|------|---------|---------------|
| Default | `/` | Legacy data updates | Optional |
| Storage | `/storage` | Collection CRUD events | Yes |
| Alarm | `/alarm` | Alert broadcasting | Yes |

### 3.3 Default Namespace (`/`)

**Location:** `lib/server/websocket.js`

**Client Connection:**
```javascript
const socket = io('https://nightscout.example.com/', {
  query: { token: 'access-token' }
});
```

**Server Events (outbound):**

| Event | Payload | Trigger |
|-------|---------|---------|
| `dataUpdate` | `{ delta, ... }` | Data change |
| `alarm` | Notification object | Warning alarm |
| `urgent_alarm` | Notification object | Urgent alarm |
| `announcement` | Notification object | User announcement |
| `clear_alarm` | `{}` | Alarm cleared |
| `connect` | (none) | Connection established |

**Client Events (inbound):**

| Event | Payload | Action |
|-------|---------|--------|
| `authorize` | `{ client, secret, token, history }` | Authenticate |
| `ack` | `{ level, group, silenceTime }` | Acknowledge alarm |

### 3.4 Storage Namespace (`/storage`)

**Location:** `lib/api3/storageSocket.js`

**Subscription:**
```javascript
socket.emit('subscribe', {
  accessToken: 'mytoken-abc123',
  collections: ['entries', 'treatments']  // Optional filter
}, function(response) {
  if (response.success) {
    console.log('Subscribed to:', response.collections);
  }
});
```

**Server Events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `create` | `{ colName, doc }` | Document created |
| `update` | `{ colName, doc }` | Document updated |
| `delete` | `{ colName, identifier }` | Document deleted |
| `subscribed` | `{ collections }` | Subscription confirmed |

**Permission Mapping:**
```javascript
const permission = (col === 'settings') 
  ? `api:${col}:admin` 
  : `api:${col}:read`;
```

### 3.5 Alarm Namespace (`/alarm`)

**Location:** `lib/api3/alarmSocket.js`

**Subscription:**
```javascript
socket.emit('subscribe', {
  accessToken: 'mytoken-abc123'
}, function(response) {
  if (response.success) {
    console.log('Subscribed to alarms');
  }
});
```

**Server Events:**

| Event | Payload | Level |
|-------|---------|-------|
| `announcement` | Notification object | INFO |
| `alarm` | Notification object | WARN |
| `urgent_alarm` | Notification object | URGENT |
| `clear_alarm` | `{}` | Clear |

**Acknowledgment:**
```javascript
socket.on('ack', function(level, group, silenceTime) {
  ctx.notifications.ack(level, group, silenceTime);
});
```

---

## 4. Client-Side Integration

### 4.1 Web Dashboard

**Location:** `lib/client/index.js`, `lib/client/socket.js`

**Connection Flow:**
1. Page loads → Get server status
2. Connect to default namespace
3. Send `authorize` with token
4. Subscribe to data updates
5. Handle real-time events

**Event Handlers:**
```javascript
socket.on('dataUpdate', function(data) {
  // Merge delta into local cache
  receiveDData.mergeDataUpdate(data.delta, ...);
  // Trigger chart update
  chart.update();
});

socket.on('alarm', function(alarm) {
  // Show alarm notification
  client.showNotification(alarm);
  // Play alarm sound
  audio.play();
});
```

### 4.2 Mobile/Third-Party Clients

**Common Patterns:**
1. Connect to appropriate namespace
2. Subscribe with access token
3. Handle `dataUpdate` or granular CRUD events
4. Reconnect on disconnect

**Reconnection Strategy:**
```javascript
const socket = io(serverUrl, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});
```

---

## 5. Data Update Mechanism

### 5.1 Heartbeat-Driven Updates

**Configuration:** `HEARTBEAT` environment variable (default: 60 seconds)

**Flow:**
```
Timer (every 60s)
    ↓ emit('tick')
Event Bus
    ↓
Data Loader (debounced)
    ↓ query MongoDB
    ↓ merge new data
    ↓ emit('data-loaded')
Plugin System
    ↓ process data
    ↓ check notifications
    ↓ emit('data-processed')
WebSocket
    ↓ broadcast to clients
```

### 5.2 API-Triggered Updates

**Flow:**
```
API POST /entries
    ↓ save to MongoDB
    ↓ emit('data-received')
Event Bus
    ↓ (immediate, bypasses debounce delay)
Data Loader
    ↓ ... same as above
```

### 5.3 Delta Calculation

**Location:** `lib/data/calcdelta.js`

**Purpose:** Calculate minimal update for WebSocket clients

**Algorithm:**
1. Compare current data with last sent data
2. Identify new, modified, deleted items
3. Create delta object with changes only
4. Track last sent timestamp per client

**Delta Object:**
```javascript
{
  delta: true,
  lastUpdated: 1595001000000,
  sgvs: [/* new/changed entries */],
  treatments: [/* new/changed treatments */],
  mbgs: [],
  cals: [],
  profiles: [],
  devicestatus: []
}
```

---

## 6. Latency Analysis

### 6.1 End-to-End Latency

**Typical Path (CGM → Dashboard):**

| Stage | Typical Latency | Notes |
|-------|----------------|-------|
| CGM → Uploader | 5 minutes | CGM reading interval |
| Uploader → API | 100-500ms | Network + API processing |
| API → MongoDB | 10-50ms | Database write |
| MongoDB → Event Bus | <1ms | Same process |
| Event Bus → Plugins | 100-300ms | Data loading + processing |
| Plugins → WebSocket | <10ms | Broadcast |
| WebSocket → Client | 50-200ms | Network |
| **Total** | **5-6 minutes** | CGM interval is dominant |

### 6.2 Real-Time Delay Factors

| Factor | Impact | Mitigation |
|--------|--------|------------|
| Heartbeat interval | 0-60s delay | Reduce interval (trade-off: resources) |
| Debounce threshold | 5s delay | Reduce threshold |
| Plugin processing | 100-300ms | Optimize plugins |
| Network latency | Variable | CDN for static assets |
| Client processing | 50-100ms | Optimize JavaScript |

### 6.3 Latency Optimization Recommendations

1. **Reduce heartbeat interval** for critical updates (30s)
2. **Bypass debounce** for urgent data
3. **Priority queue** for alarm events
4. **Client prediction** to compensate for delay
5. **Optimistic updates** in UI

---

## 7. Scalability Considerations

### 7.1 Current Limitations

| Limitation | Impact | Threshold |
|------------|--------|-----------|
| Single process | No horizontal scaling | ~1000 concurrent connections |
| In-memory state | Lost on restart | N/A |
| No load balancing | Single point of failure | N/A |
| No connection limits | DoS vulnerability | N/A |

### 7.2 Scaling Strategies

**Vertical Scaling:**
- Increase Node.js memory
- Use worker threads for CPU tasks
- Optimize event handlers

**Horizontal Scaling:**
```
                    ┌─────────────┐
                    │   Load      │
                    │  Balancer   │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  Nightscout │ │  Nightscout │ │  Nightscout │
    │  Instance 1 │ │  Instance 2 │ │  Instance 3 │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    │   Pub/Sub   │
                    └─────────────┘
```

**Requirements for Horizontal Scaling:**
1. Redis adapter for Socket.IO
2. Shared session store
3. Database connection pooling
4. Sticky sessions (or Redis pub/sub)

### 7.3 Socket.IO Redis Adapter

**Implementation:**
```javascript
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));
```

---

## 8. Reliability

### 8.1 Connection Handling

**Current Behavior:**
- Automatic reconnection (Socket.IO default)
- No connection health checks
- No graceful degradation

**Recommendations:**
1. Implement connection heartbeat
2. Add connection timeout handling
3. Queue messages during disconnect
4. Implement exponential backoff

### 8.2 Error Handling

**Current Issues:**
- Some errors silently swallowed
- No error event for clients
- No error aggregation

**Recommendations:**
```javascript
socket.on('error', function(error) {
  console.error('Socket error:', error);
  // Notify monitoring
  // Attempt recovery
});

io.engine.on('connection_error', function(err) {
  console.error('Connection error:', err);
});
```

### 8.3 Graceful Shutdown

**Location:** `lib/bus.js`

**Current Implementation:**
```javascript
stream.teardown = function () {
  console.log('Initiating server teardown');
  clearInterval(busInterval);
  stream.emit('teardown');
};
```

**Recommendations:**
1. Notify connected clients of shutdown
2. Wait for pending operations
3. Close connections gracefully
4. Implement shutdown timeout

---

## 9. Monitoring

### 9.1 Current Metrics

- Connection count (via Socket.IO)
- Basic console logging

### 9.2 Recommended Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `socket_connections_total` | Gauge | Active connections |
| `socket_messages_sent_total` | Counter | Message volume |
| `socket_message_latency_ms` | Histogram | Performance |
| `event_bus_events_total` | Counter | Internal events |
| `data_update_latency_ms` | Histogram | Update pipeline |

### 9.3 Alerting Recommendations

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Connection drop | >50% in 5min | Alert |
| Message latency | >5s p99 | Alert |
| Event bus backlog | >100 events | Warn |
| Memory usage | >80% | Warn |

---

## 10. Security Considerations

### 10.1 Authentication

- Default namespace: Optional auth
- Storage/Alarm namespaces: Required auth
- Token validated per subscription

### 10.2 Authorization

- Storage: Per-collection permission check
- Alarm: Any valid token accepted

### 10.3 Rate Limiting

**Current State:** No rate limiting on WebSocket

**Recommendations:**
```javascript
// Limit events per client
const rateLimit = require('socket-rate-limiter');
io.use(rateLimit({
  points: 100,  // 100 events
  duration: 60  // per minute
}));
```

---

## 11. Recommendations Summary

### Critical

1. **Add connection rate limiting** - Prevent DoS
2. **Implement proper error handling** - Reliability
3. **Add health check endpoint** - Monitoring

### High Priority

4. **Add Redis adapter** for horizontal scaling
5. **Implement connection metrics** - Observability
6. **Add message queue** for reliability

### Medium Priority

7. **Reduce heartbeat interval** - Lower latency
8. **Implement graceful shutdown** - Zero downtime
9. **Add TypeScript definitions** - Developer experience

### Low Priority

10. **WebSocket compression** - Bandwidth reduction
11. **Binary protocol option** - Performance
12. **Event sourcing** - Audit trail

---

## 12. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [Security Audit](./security-audit.md)
- [API Layer Audit](./api-layer-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)
