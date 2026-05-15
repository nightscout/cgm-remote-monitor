# Data Layer Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** MongoDB collections, schemas, historical data handling, auto-pruning, sync mechanisms

---

## 1. Executive Summary

Nightscout uses MongoDB as its primary data store, managing glucose readings, treatments, device statuses, and configuration data. This audit examines the data model, indexing strategy, and data lifecycle management.

### Data Layer Overview

| Metric | Value |
|--------|-------|
| Database | MongoDB 3.6+ |
| Driver | mongodb ^3.6.0 (Node.js) |
| Collections | 7 primary + 1 auth |
| Index Strategy | Date-based + identifier |
| Retention | Configurable auto-prune |

---

## 2. Storage Architecture

### 2.1 Storage Adapters

**Location:** `lib/storage/`

| Adapter | File | Purpose |
|---------|------|---------|
| MongoDB | `mongo-storage.js` | Primary production storage |
| OpenAPS | `openaps-storage.js` | Alternative for OpenAPS integration |

### 2.2 Connection Configuration

**Environment Variables:**
```
MONGODB_URI=mongodb://host:port/database
MONGO_COLLECTION=entries
MONGO_TREATMENTS_COLLECTION=treatments
MONGO_DEVICESTATUS_COLLECTION=devicestatus
MONGO_PROFILE_COLLECTION=profile
MONGO_FOOD_COLLECTION=food
MONGO_ACTIVITY_COLLECTION=activity
```

### 2.3 Connection Pool

**Current Settings:**
- Default pool size: MongoDB driver default (100)
- No explicit pool configuration
- Connection established during boot

**Recommendations:**
- Add explicit pool size configuration
- Implement connection health checks
- Add connection retry logic

---

## 3. Collection Schemas

### 3.1 Entries Collection

**Purpose:** Glucose sensor readings (SGV - Sensor Glucose Value)

**Schema:**
```javascript
{
  _id: ObjectId,
  type: String,           // "sgv", "mbg", "cal", "etc"
  sgv: Number,            // Glucose value (mg/dL)
  mbg: Number,            // Manual BG value
  direction: String,      // "Flat", "SingleUp", "DoubleDown", etc.
  trend: Number,          // Numeric trend (1-7)
  device: String,         // Uploader device identifier
  date: Number,           // Unix timestamp (ms)
  dateString: String,     // ISO 8601 string
  mills: Number,          // Unix timestamp (ms) - computed
  filtered: Number,       // Raw filtered value
  unfiltered: Number,     // Raw unfiltered value
  rssi: Number,           // Signal strength
  noise: Number,          // Noise level (1-4)
  sysTime: String,        // System time string
  
  // API v3 additions
  identifier: String,     // Unique document ID
  srvCreated: Number,     // Server creation timestamp
  srvModified: Number,    // Server modification timestamp
  isValid: Boolean,       // Soft delete flag
  isReadOnly: Boolean     // Lock flag
}
```

**Indexed Fields:**
- `date` (descending) - Primary query index
- `type` - Filter by entry type
- `sgv` - Range queries
- `dateString` - String date queries

**Volume Estimate:**
- ~288 entries/day (5-minute intervals)
- ~8,640 entries/month
- ~103,680 entries/year

### 3.2 Treatments Collection

**Purpose:** Insulin doses, carbohydrates, notes, and other treatment events

**Schema:**
```javascript
{
  _id: ObjectId,
  eventType: String,      // "Correction Bolus", "Meal Bolus", "Carb Correction", etc.
  created_at: String,     // ISO 8601 string
  glucose: Number,        // BG at time of treatment
  glucoseType: String,    // "Sensor" or "Finger"
  carbs: Number,          // Carbohydrates (g)
  insulin: Number,        // Insulin (units)
  duration: Number,       // Duration (minutes)
  notes: String,          // Free text notes
  enteredBy: String,      // User/device identifier
  
  // Specific to treatment types
  profile: String,        // Profile name (for profile switch)
  percentage: Number,     // Temp basal percentage
  absolute: Number,       // Temp basal absolute rate
  reason: String,         // Override reason
  targetTop: Number,      // Target range top
  targetBottom: Number,   // Target range bottom
  
  // API v3 additions
  identifier: String,
  srvCreated: Number,
  srvModified: Number,
  isValid: Boolean,
  isReadOnly: Boolean
}
```

**Indexed Fields:**
- `created_at` (descending) - Primary query index
- `eventType` - Filter by treatment type

**Treatment Types:**
| eventType | Description |
|-----------|-------------|
| Correction Bolus | Insulin to correct high BG |
| Meal Bolus | Insulin for meal |
| Carb Correction | Carbs to correct low BG |
| Temp Basal | Temporary basal rate |
| Profile Switch | Change active profile |
| Site Change | Pump site change |
| Sensor Start | CGM sensor start |
| Note | General note |
| Announcement | System announcement |
| Question | Caregiver question |

### 3.3 Device Status Collection

**Purpose:** Loop/pump status, uploader status, device telemetry

**Schema:**
```javascript
{
  _id: ObjectId,
  device: String,         // Device identifier
  created_at: String,     // ISO 8601 string
  
  // Uploader status
  uploader: {
    battery: Number,      // Battery percentage
    batteryVoltage: Number
  },
  
  // Loop status (OpenAPS/Loop/etc)
  loop: {
    timestamp: String,
    iob: Object,          // Insulin on board
    cob: Object,          // Carbs on board
    predicted: Object,    // BG predictions
    enacted: Object,      // Enacted changes
    failureReason: String
  },
  
  // Pump status
  pump: {
    clock: String,
    reservoir: Number,    // Insulin remaining
    battery: Object,
    status: Object
  },
  
  // OpenAPS specific
  openaps: {
    enacted: Object,
    suggested: Object
  },
  
  // API v3 additions
  identifier: String,
  srvCreated: Number,
  srvModified: Number,
  isValid: Boolean
}
```

**Indexed Fields:**
- `created_at` (descending)
- `device`

**Volume Estimate:**
- ~144 entries/day (10-minute intervals)
- Very large documents (~2-5KB each)

### 3.4 Profile Collection

**Purpose:** User profiles with basal rates, insulin ratios, sensitivity

**Schema:**
```javascript
{
  _id: ObjectId,
  defaultProfile: String, // Name of default profile
  store: {
    [profileName]: {
      dia: Number,        // Duration of insulin action (hours)
      carbratio: Array,   // Carb ratios by time
      sens: Array,        // Sensitivity factors by time
      basal: Array,       // Basal rates by time
      target_low: Array,  // Target low by time
      target_high: Array, // Target high by time
      timezone: String,   // Timezone
      units: String       // "mg/dl" or "mmol"
    }
  },
  startDate: String,      // ISO 8601 string
  mills: Number,          // Computed timestamp
  
  // API v3 additions
  identifier: String,
  srvCreated: Number,
  srvModified: Number
}
```

**Indexed Fields:**
- `created_at` (descending)
- `startDate`

### 3.5 Food Collection

**Purpose:** Food database for carb counting

**Schema:**
```javascript
{
  _id: ObjectId,
  name: String,           // Food name
  category: String,       // Category (Snacks, Meals, etc.)
  subcategory: String,    // Subcategory
  portion: Number,        // Portion size
  unit: String,           // Unit of portion
  carbs: Number,          // Carbs per portion
  fat: Number,            // Fat per portion
  protein: Number,        // Protein per portion
  energy: Number,         // Calories per portion
  gi: Number,             // Glycemic index
  
  // API v3 additions
  identifier: String,
  srvCreated: Number,
  srvModified: Number
}
```

**Indexed Fields:**
- `name` - Search index
- `category`

### 3.6 Activity Collection

**Purpose:** Activity/exercise logging

**Schema:**
```javascript
{
  _id: ObjectId,
  created_at: String,     // ISO 8601 string
  activityType: String,   // Type of activity
  duration: Number,       // Duration in minutes
  steps: Number,          // Step count
  heartRate: Number,      // Heart rate
  notes: String,          // Notes
  
  // API v3 additions
  identifier: String,
  srvCreated: Number,
  srvModified: Number
}
```

### 3.7 Settings Collection (API v3)

**Purpose:** Application settings storage

**Schema:**
```javascript
{
  _id: ObjectId,
  identifier: String,
  type: String,           // Setting type
  value: Mixed,           // Setting value
  srvCreated: Number,
  srvModified: Number,
  isValid: Boolean
}
```

### 3.8 Auth Subjects Collection

**Purpose:** Authorization subjects (users/devices)

**Schema:**
```javascript
{
  _id: ObjectId,
  name: String,           // Subject name
  accessToken: String,    // Access token
  roles: Array,           // Assigned roles
  notes: String           // Notes
}
```

---

## 4. Indexing Strategy

### 4.1 Current Indexes

**Entries:**
```javascript
db.entries.createIndex({ date: -1 })
db.entries.createIndex({ type: 1 })
db.entries.createIndex({ sgv: 1 })
db.entries.createIndex({ dateString: -1 })
```

**Treatments:**
```javascript
db.treatments.createIndex({ created_at: -1 })
db.treatments.createIndex({ eventType: 1 })
```

**DeviceStatus:**
```javascript
db.devicestatus.createIndex({ created_at: -1 })
db.devicestatus.createIndex({ device: 1 })
```

### 4.2 Index Creation

**Location:** `lib/server/bootevent.js` - `ensureIndexes` function

Indexes are created/verified on every server boot using `ensureIndexes`.

**Issues:**
- Index creation on boot causes startup delay
- No migration system for index changes
- Potential for duplicate index creation attempts

**Recommendations:**
- Implement proper database migration system
- Add index creation script (run separately)
- Remove ensureIndexes from boot sequence

---

## 5. Data Lifecycle Management

### 5.1 Data Creation

**API v1:**
```http
POST /api/v1/entries
Content-Type: application/json

[{"sgv": 120, "date": 1595000000000, "type": "sgv"}]
```

**API v3:**
```http
POST /api/v3/entries
Content-Type: application/json

{"sgv": 120, "date": 1595000000000, "type": "sgv"}
```

### 5.2 Data Deduplication

**Location:** `lib/api3/shared/operationTools.js`

API v3 implements deduplication based on:
1. `identifier` field (primary)
2. Combination of key fields (fallback)

**Dedup Logic:**
```javascript
// Fallback dedup for entries
{ date: doc.date, type: doc.type, app: doc.app }

// Fallback dedup for treatments
{ created_at: doc.created_at, eventType: doc.eventType }
```

### 5.3 Soft Delete

API v3 supports soft delete via `isValid` field:
- `isValid: true` - Document is active
- `isValid: false` - Document is logically deleted

**Behavior:**
- Default queries filter `isValid: true`
- History endpoint includes all documents
- Permanent deletion available for admins

### 5.4 Auto-Prune

**Location:** `lib/api3/generic/collection.js`

**Configuration:**
```
DEVICESTATUS_DAYS=2     # Keep 2 days of device status
ENTRIES_DAYS=0          # 0 = no auto-prune
TREATMENTS_DAYS=0       # 0 = no auto-prune
```

**Prune Logic:**
```javascript
self.autoPrune = function autoPrune () {
  if (autoPruneDays <= 0) return;
  
  const deleteBefore = new Date(Date.now() - (autoPruneDays * 24 * 3600 * 1000));
  
  const filter = [
    { field: 'srvCreated', operator: 'lt', value: deleteBefore.getTime() },
    { field: 'created_at', operator: 'lt', value: deleteBefore.toISOString() },
    { field: 'date', operator: 'lt', value: deleteBefore.getTime() }
  ];
  
  self.storage.deleteManyOr(filter, callback);
};
```

**Issues:**
- Prune runs on interval (not transactional)
- No archive before delete
- Different date fields for different collections

**Recommendations:**
- Implement data archival before pruning
- Add prune audit logging
- Standardize timestamp fields

---

## 6. Data Synchronization

### 6.1 Incremental Sync (API v3)

**Endpoint:** `GET /{collection}/history/{lastModified}`

**Flow:**
```
Client: GET /api/v3/entries/history/1595000000000
Server: Returns all entries modified after timestamp
Client: Stores latest srvModified
Client: Next sync uses new timestamp
```

**Response:**
```json
{
  "status": 200,
  "result": [
    {
      "identifier": "abc123",
      "sgv": 120,
      "srvModified": 1595001000000,
      "isValid": true
    }
  ]
}
```

### 6.2 Delta Calculation

**Location:** `lib/data/calcdelta.js`

For WebSocket clients, delta calculation computes changes since last update:
- New entries
- Modified entries
- Deleted entries

### 6.3 Real-Time Updates

**Location:** `lib/api3/storageSocket.js`

After any CRUD operation in API v3:
1. Event emitted to bus (`storage-socket-create`, etc.)
2. StorageSocket broadcasts to subscribed clients
3. Clients receive `create`, `update`, or `delete` event

---

## 7. Data Validation

### 7.1 Current Validation

**API v1:** Minimal validation (type checking only)

**API v3:** Schema-based validation using internal validators

**Entry Validation:**
```javascript
// Required fields
if (!doc.date) throw new Error('date required');
if (!doc.type) throw new Error('type required');

// Type validation
if (doc.sgv && typeof doc.sgv !== 'number') throw new Error('sgv must be number');
```

### 7.2 Validation Gaps

| Field | Issue | Risk |
|-------|-------|------|
| `sgv` | No range validation | Invalid values stored |
| `date` | Future dates allowed | Data integrity |
| `direction` | No enum validation | Invalid strings |
| `notes` | No length limit | DoS via large payloads |

### 7.3 Recommendations

1. Implement JSON Schema validation
2. Add range validation for numeric fields
3. Add enum validation for string fields
4. Implement payload size limits
5. Sanitize string inputs (XSS prevention)

---

## 8. Query Patterns

### 8.1 Common Queries

**Latest Entry:**
```javascript
db.entries.find({ type: 'sgv' })
  .sort({ date: -1 })
  .limit(1)
```

**Entries in Time Range:**
```javascript
db.entries.find({
  date: { $gte: startTime, $lte: endTime },
  type: 'sgv'
}).sort({ date: -1 })
```

**Recent Treatments:**
```javascript
db.treatments.find({
  created_at: { $gte: startTime }
}).sort({ created_at: -1 })
```

### 8.2 Aggregation Pipelines

**Daily Statistics (Report Plugin):**
```javascript
db.entries.aggregate([
  { $match: { date: { $gte: startTime }, type: 'sgv' } },
  { $group: {
    _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
    avg: { $avg: "$sgv" },
    min: { $min: "$sgv" },
    max: { $max: "$sgv" },
    count: { $sum: 1 }
  }}
])
```

### 8.3 Query Optimization

**Current Issues:**
- Some queries don't use indexes effectively
- No query result caching
- Full collection scans for some reports

**Recommendations:**
- Add compound indexes for common query patterns
- Implement query result caching (Redis)
- Add query timeouts
- Monitor slow queries

---

## 9. Backup and Recovery

### 9.1 Current State

- No built-in backup mechanism
- Relies on hosting provider backups
- No point-in-time recovery

### 9.2 Recommendations

1. **Automated Backups:**
   - Daily mongodump to cloud storage
   - 30-day retention

2. **Point-in-Time Recovery:**
   - Enable MongoDB oplog
   - Use replica set for HA

3. **Export Functionality:**
   - Add data export API for users
   - Support CSV, JSON formats

---

## 10. Performance Metrics

### 10.1 Typical Query Performance

| Query Type | Documents | Response Time |
|------------|-----------|---------------|
| Latest entry | 1 | <10ms |
| Last hour entries | ~12 | <20ms |
| Last 24h entries | ~288 | <50ms |
| Last 7 days entries | ~2,016 | <200ms |
| Last 30 days entries | ~8,640 | <500ms |

### 10.2 Collection Sizes

**Typical 1-Year Instance:**
| Collection | Documents | Size |
|------------|-----------|------|
| entries | ~100,000 | ~50MB |
| treatments | ~5,000 | ~5MB |
| devicestatus | ~50,000 | ~200MB |
| profile | ~100 | ~1MB |
| food | ~500 | ~500KB |

### 10.3 Optimization Recommendations

1. **Index Usage:** Monitor and optimize indexes
2. **Document Size:** Reduce devicestatus bloat
3. **Archival:** Move old data to cold storage
4. **Caching:** Add Redis for frequently accessed data

---

## 11. Data Shape Handling in Storage Layer

**See Also:** [Data Shape Requirements](./requirements/data-shape-requirements.md), [Shape Handling Tests](./test-specs/shape-handling-tests.md)

### 11.1 Storage Create Methods

Each storage module has specific input shape requirements:

| Module | File | Single Object | Array Input |
|--------|------|---------------|-------------|
| treatments | `lib/server/treatments.js` | Supported | Supported |
| devicestatus | `lib/server/devicestatus.js` | Supported | Supported |
| entries | `lib/server/entries.js` | Supported | Supported |
| profile | `lib/server/profile.js` | Supported | Not used |
| food | `lib/server/food.js` | Supported | Not used |
| activity | `lib/server/activity.js` | NOT supported | Required |

### 11.2 Timestamp Normalization

Storage modules automatically add `created_at` if missing:

```javascript
if (!doc.created_at) {
  doc.created_at = new Date().toISOString();
}
```

### 11.3 MongoDB 5.x Migration Notes

During driver upgrade testing, these issues were identified and fixed:

1. **devicestatus.create() race condition** - Closure variable capture in async loop caused data loss with arrays
2. **Sequential processing** - All array inputs now use `async.eachSeries()` for reliable processing

---

## 12. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [API Layer Audit](./api-layer-audit.md)
- [Real-Time Systems Audit](./realtime-systems-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)

### Requirements & Specifications

- [Data Shape Requirements](../requirements/data-shape-requirements.md) - Formal requirements for input/output shapes
- [API v1 Compatibility Requirements](../requirements/api-v1-compatibility-requirements.md) - Client compatibility requirements
- [Shape Handling Tests](../test-specs/shape-handling-tests.md) - Test case specifications
