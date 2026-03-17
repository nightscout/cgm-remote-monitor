# MongoDB Modernization Impact Assessment

## Client Data Upload Patterns for Nightscout v3

**Document Version:** 1.0  
**Date:** 2026-01-18  
**Purpose:** Guide Nightscout core team on MongoDB driver updates, particularly regarding multi-document operations

---

## Executive Summary

This assessment analyzes how the three major closed-loop systems (AndroidAPS, Loop, and Trio) send data to Nightscout. The findings inform safe MongoDB modernization strategies.

### Key Findings

| Client | API Version | Upload Pattern | Batch Size | Deduplication Strategy |
|--------|-------------|----------------|------------|------------------------|
| **AAPS** | v3 | Sequential single docs | 1 per request | `pumpId` + `pumpType` + `pumpSerial` composite key |
| **Loop** | v1 | Batch arrays | Up to 1000 | `syncIdentifier` → `objectId` cache |
| **Trio** | v1 | Batch arrays | Throttled pipelines (2s window) | `enteredBy` filtering, `id` field |

### Critical MongoDB Considerations

1. **Loop and Trio send arrays** to v1 API endpoints, expecting batch insert behavior
2. **AAPS sends single documents** to v3 API endpoints
3. **Deduplication responses are critical** - clients depend on `isDeduplication` field
4. **insertOne vs insertMany distinction matters** for v1 API batch operations

---

## 1. AndroidAPS (AAPS) Data Patterns

**Source files analyzed:**
- `core/nssdk/src/main/kotlin/app/aaps/core/nssdk/interfaces/NSAndroidClient.kt`
- `core/nssdk/src/main/kotlin/app/aaps/core/nssdk/NSAndroidClientImpl.kt`
- `plugins/sync/src/main/kotlin/app/aaps/plugins/sync/nsclientV3/DataSyncSelectorV3.kt`
- `core/nssdk/src/main/kotlin/app/aaps/core/nssdk/remotemodel/RemoteTreatment.kt`

### 1.1 API Usage

AAPS uses **Nightscout API v3** for data sync operations (confirmed: no v1 endpoints in `core/nssdk`):

```
POST /api/v3/entries      (single RemoteEntry)
POST /api/v3/treatments   (single RemoteTreatment)
POST /api/v3/devicestatus (single RemoteDeviceStatus)
PATCH /api/v3/treatments/{identifier}
DELETE /api/v3/treatments/{identifier}
```

**Note:** While v3 is the primary sync mechanism, response format changes could still impact deduplication logic. The client relies on `CreateUpdateResponse` containing `identifier`, `isDeduplication`, and `deduplicatedIdentifier` fields.

### 1.2 Upload Pattern: Sequential Processing

From `plugins/sync/.../DataSyncSelectorV3.kt`:

```kotlin
// AAPS processes records ONE AT A TIME in a while loop
while (cont) {
    persistenceLayer.getNextSyncElementBolus(startId).blockingGet()?.let { bolus ->
        cont = activePlugin.activeNsClient?.nsAdd("treatments", ...) == true
        // Waits for response before next iteration
        if (cont) confirmLastBolusIdIfGreater(bolus.second.id)
    }
}
```

**Important:** While AAPS sends single documents, it still depends on response schema. Changes to `CreateUpdateResponse` fields (`identifier`, `isDeduplication`, `deduplicatedIdentifier`, `lastModified`) would break sync logic.

### 1.3 Data Shapes

#### RemoteEntry (CGM readings)
```json
{
  "type": "sgv",
  "sgv": 120,
  "date": 1705600000000,
  "dateString": "2024-01-18T12:00:00.000Z",
  "device": "AndroidAPS-DexcomG6",
  "direction": "Flat",
  "identifier": null,
  "srvModified": null,
  "srvCreated": null,
  "app": "AAPS",
  "utcOffset": 120,
  "isValid": true
}
```

#### RemoteTreatment (boluses, carbs, temp basals)
```json
{
  "eventType": "Correction Bolus",
  "insulin": 0.25,
  "created_at": "2024-01-18T12:00:00.000Z",
  "date": 1705579200000,
  "type": "SMB",
  "isValid": true,
  "isSMB": true,
  "pumpId": 4148,
  "pumpType": "ACCU_CHEK_INSIGHT_BLUETOOTH",
  "pumpSerial": "33013206",
  "app": "AAPS"
}
```

#### RemoteDeviceStatus
```json
{
  "app": "AAPS",
  "date": 1705579200000,
  "device": "openaps://samsung SM-G970F",
  "uploaderBattery": 85,
  "pump": {
    "clock": "2024-01-18T12:00:00.000Z",
    "reservoir": 150.5,
    "battery": { "percent": 75 },
    "status": { "status": "normal", "timestamp": "..." }
  },
  "openaps": {
    "suggested": { "temp": "absolute", "bg": 120, ... },
    "enacted": { ... },
    "iob": { "iob": 2.5, "basaliob": 1.2, ... }
  }
}
```

### 1.4 Deduplication Keys

AAPS uses a composite key for deduplication:
- `identifier` - Server-assigned document ID
- `pumpId` + `pumpType` + `pumpSerial` - Unique pump event identification
- `srvModified` - Conflict detection timestamp

### 1.5 Expected Server Response

```json
{
  "identifier": "60ed782dc574da0004a38595",
  "isDeduplication": false,
  "deduplicatedIdentifier": null,
  "lastModified": 1705579200000
}
```

**Critical:** If `isDeduplication: true`, AAPS stores the `deduplicatedIdentifier` instead of creating a new record.

---

## 2. Loop Data Patterns

**Source files analyzed:**
- `NightscoutServiceKit/NightscoutService/NightscoutService.swift`
- `NightscoutServiceKit/Extensions/NightscoutUploader.swift`
- `NightscoutServiceKit/Cache/ObjectIdCache.swift`

### 2.1 API Usage

Loop uses **Nightscout API v1** with batch operations:

```
POST /api/v1/entries.json      (array of entries)
POST /api/v1/treatments.json   (array of treatments)
POST /api/v1/devicestatus.json (array of statuses)
PUT /api/v1/treatments.json    (modify treatments)
DELETE /api/v1/treatments.json (delete by objectId)
```

### 2.2 Upload Pattern: Batched Arrays

From `NightscoutService.swift`:

```swift
public var carbDataLimit: Int? { return 1000 }
public var doseDataLimit: Int? { return 1000 }
public var glucoseDataLimit: Int? { return 1000 }

func uploadCarbData(created: [SyncCarbObject], updated: [SyncCarbObject], ...) {
    uploader.createCarbData(created) { result in
        // Processes batch response with object IDs
        for (syncIdentifier, objectId) in zip(syncIdentifiers, createdObjectIds) {
            self.objectIdCache.add(syncIdentifier: syncIdentifier, objectId: objectId)
        }
    }
}
```

**Implication:** Loop EXPECTS arrays to be inserted as multiple documents, not as a single document containing an array.

### 2.3 Data Shapes

#### Glucose Entry
```json
{
  "type": "sgv",
  "sgv": 120,
  "date": 1705579200000,
  "dateString": "2024-01-18T12:00:00.000Z",
  "direction": "Flat",
  "device": "loop://iPhone"
}
```

#### Carb Correction Treatment
```json
{
  "_id": "...",
  "eventType": "Carb Correction",
  "carbs": 15,
  "created_at": "2024-01-18T12:00:00.000Z",
  "enteredBy": "loop://iPhone",
  "notes": ""
}
```

#### Dose Entry (Bolus/Basal)
```json
{
  "eventType": "Temp Basal",
  "created_at": "2024-01-18T12:00:00.000Z",
  "enteredBy": "loop://iPhone",
  "duration": 30,
  "rate": 1.5,
  "absolute": 1.5
}
```

### 2.4 ObjectId Cache

Loop maintains a local cache mapping `syncIdentifier` → Nightscout `objectId`:

```swift
class ObjectIdCache {
    func add(syncIdentifier: String, objectId: String)
    func findObjectIdBySyncIdentifier(_ syncIdentifier: String) -> String?
    func purge(before date: Date)  // 24-hour retention
}
```

**Critical:** The server response must return objectIds in the same order as the submitted array.

---

## 3. Trio Data Patterns

**Source files analyzed:**
- `Trio/Sources/Services/Network/Nightscout/NightscoutAPI.swift`
- `Trio/Sources/Services/Network/Nightscout/NightscoutManager.swift`
- `Trio/Sources/Services/Network/Nightscout/NightscoutUploadPipeline.swift`
- `Trio/Sources/Models/NightscoutTreatment.swift`

### 3.1 API Usage

Trio uses **Nightscout API v1** with batched operations and throttled pipelines:

```
POST /api/v1/entries.json      (array of BloodGlucose)
POST /api/v1/treatments.json   (array of NightscoutTreatment)
POST /api/v1/devicestatus.json (single NightscoutStatus)
POST /api/v1/profile.json      (single profile)
DELETE /api/v1/treatments.json (by id or created_at)
```

### 3.2 Upload Pattern: Throttled Pipelines

From `NightscoutManager.swift`:

```swift
let uploadPipelineInterval: [NightscoutUploadPipeline: TimeInterval] = [
    .carbs: 2, .pumpHistory: 2, .overrides: 2, .tempTargets: 2,
    .glucose: 2, .manualGlucose: 2, .deviceStatus: 2
]

// Subject → Throttle (2s) → Upload
subject
    .throttle(for: .seconds(window), scheduler: uploadPipelineQueue, latest: false)
    .sink { await self.runUploadPipeline(pipeline) }
```

### 3.3 Data Shapes

#### NightscoutTreatment
```json
{
  "eventType": "Meal Bolus",
  "created_at": "2024-01-18T12:00:00.000Z",
  "enteredBy": "Trio",
  "insulin": 5.0,
  "carbs": 45,
  "notes": "",
  "id": "uuid-string"
}
```

#### BloodGlucose (Entry)
```json
{
  "sgv": 120,
  "date": 1705579200000,
  "dateString": "2024-01-18T12:00:00.000Z",
  "direction": "Flat",
  "type": "sgv",
  "device": "Trio"
}
```

#### NightscoutStatus (DeviceStatus)
```json
{
  "device": "Trio",
  "created_at": "2024-01-18T12:00:00.000Z",
  "uploaderBattery": 85,
  "pump": {
    "clock": "2024-01-18T12:00:00.000Z",
    "reservoir": 150,
    "battery": { "percent": 75 },
    "status": { "status": "normal" }
  },
  "openaps": {
    "suggested": { ... },
    "enacted": { ... },
    "iob": { ... }
  }
}
```

### 3.4 Filtering and Deduplication

Trio filters incoming data by `enteredBy` to avoid processing its own uploads:

```swift
private let excludedEnteredBy: [String] = [
    "Trio",
    "AndroidAPS",
    "openaps://AndroidAPS",
    "iAPS",
    "loop://iPhone"
]
```

---

## 4. Test Fixtures for MongoDB Modernization

### 4.1 Critical Test: insertOne vs insertMany Behavior

The existing test in `storage.shape-handling.test.js` already covers this:

```javascript
it('insertOne with array creates single document containing array (NOT multiple docs)', ...)
it('insertMany with array creates multiple documents', ...)
```

**Action Required:** Ensure all v1 API endpoints use `insertMany` for array inputs, not `insertOne`.

### 4.2 Fixture Set 1: AAPS Single-Document Operations

```javascript
// test/fixtures/aaps-single-doc.js
module.exports = {
  sgvEntry: {
    type: 'sgv',
    sgv: 120,
    date: Date.now(),
    dateString: new Date().toISOString(),
    device: 'AndroidAPS-DexcomG6',
    direction: 'Flat',
    app: 'AAPS',
    utcOffset: 120
  },
  
  smbBolus: {
    eventType: 'Correction Bolus',
    insulin: 0.25,
    created_at: new Date().toISOString(),
    date: Date.now(),
    type: 'SMB',
    isValid: true,
    isSMB: true,
    pumpId: 4148,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  },

  mealBolus: {
    eventType: 'Meal Bolus',
    insulin: 8.1,
    carbs: 45,
    created_at: new Date().toISOString(),
    date: Date.now(),
    type: 'NORMAL',
    isValid: true,
    isSMB: false,
    pumpId: 4102,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  },

  tempBasal: {
    eventType: 'Temp Basal',
    created_at: new Date().toISOString(),
    enteredBy: 'openaps://AndroidAPS',
    isValid: true,
    duration: 60,
    rate: 0,
    type: 'NORMAL',
    absolute: 0,
    pumpId: 284835,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  }
};
```

### 4.3 Fixture Set 2: Loop Batch Operations

```javascript
// test/fixtures/loop-batch.js
module.exports = {
  glucoseBatch: [
    { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat', device: 'loop://iPhone' },
    { type: 'sgv', sgv: 125, date: Date.now() + 300000, direction: 'FortyFiveUp', device: 'loop://iPhone' },
    { type: 'sgv', sgv: 130, date: Date.now() + 600000, direction: 'SingleUp', device: 'loop://iPhone' }
  ],

  carbsBatch: [
    { eventType: 'Carb Correction', carbs: 15, created_at: new Date().toISOString(), enteredBy: 'loop://iPhone' },
    { eventType: 'Carb Correction', carbs: 30, created_at: new Date(Date.now() + 3600000).toISOString(), enteredBy: 'loop://iPhone' }
  ],

  doseBatch: [
    { eventType: 'Temp Basal', duration: 30, rate: 1.5, absolute: 1.5, created_at: new Date().toISOString(), enteredBy: 'loop://iPhone' },
    { eventType: 'Bolus', insulin: 2.0, created_at: new Date().toISOString(), enteredBy: 'loop://iPhone' }
  ],

  // Test batch up to limit
  largeBatch: Array.from({ length: 100 }, (_, i) => ({
    type: 'sgv',
    sgv: 100 + (i % 50),
    date: Date.now() + (i * 300000),
    direction: 'Flat',
    device: 'loop://iPhone'
  }))
};
```

### 4.4 Fixture Set 3: Trio Throttled Pipeline Scenarios

```javascript
// test/fixtures/trio-pipeline.js
module.exports = {
  glucosePipeline: [
    { sgv: 110, date: Date.now(), dateString: new Date().toISOString(), direction: 'Flat', type: 'sgv', device: 'Trio' },
    { sgv: 115, date: Date.now() + 300000, dateString: new Date(Date.now() + 300000).toISOString(), direction: 'FortyFiveUp', type: 'sgv', device: 'Trio' }
  ],

  treatmentPipeline: [
    { eventType: 'Meal Bolus', insulin: 5.0, carbs: 45, created_at: new Date().toISOString(), enteredBy: 'Trio', id: 'trio-uuid-1' },
    { eventType: 'Temporary Target', duration: 60, targetTop: 110, targetBottom: 110, created_at: new Date().toISOString(), enteredBy: 'Trio', reason: 'Eating Soon', id: 'trio-uuid-2' }
  ],

  overridePipeline: [
    { eventType: 'Exercise', duration: 60, notes: 'Running', created_at: new Date().toISOString(), enteredBy: 'Trio' }
  ],

  deviceStatus: {
    device: 'Trio',
    created_at: new Date().toISOString(),
    uploaderBattery: 85,
    pump: {
      clock: new Date().toISOString(),
      reservoir: 150,
      battery: { percent: 75 },
      status: { status: 'normal' }
    },
    openaps: {
      suggested: { temp: 'absolute', bg: 120, eventualBG: 110, COB: 10, IOB: 2.5 },
      enacted: { temp: 'absolute', bg: 120, rate: 1.2, duration: 30 },
      iob: { iob: 2.5, basaliob: 1.2, activity: 0.02 }
    }
  }
};
```

### 4.5 Fixture Set 4: Deduplication Scenarios

```javascript
// test/fixtures/deduplication.js
module.exports = {
  // Same pumpId sent twice (AAPS pattern)
  aapsDuplicate: [
    { eventType: 'Correction Bolus', pumpId: 4148, pumpType: 'DANA_R', pumpSerial: '12345', insulin: 0.25 },
    { eventType: 'Correction Bolus', pumpId: 4148, pumpType: 'DANA_R', pumpSerial: '12345', insulin: 0.25 }
  ],

  // Same syncIdentifier (Loop pattern)
  loopDuplicate: [
    { eventType: 'Carb Correction', carbs: 15, syncIdentifier: 'loop-sync-123', created_at: '2024-01-18T12:00:00.000Z' },
    { eventType: 'Carb Correction', carbs: 15, syncIdentifier: 'loop-sync-123', created_at: '2024-01-18T12:00:00.000Z' }
  ],

  // Same id field (Trio pattern)
  trioDuplicate: [
    { eventType: 'Meal Bolus', id: 'trio-uuid-abc', insulin: 5.0, created_at: '2024-01-18T12:00:00.000Z' },
    { eventType: 'Meal Bolus', id: 'trio-uuid-abc', insulin: 5.0, created_at: '2024-01-18T12:00:00.000Z' }
  ]
};
```

### 4.6 Fixture Set 5: Edge Cases

```javascript
// test/fixtures/edge-cases.js
module.exports = {
  // Empty array (should not error)
  emptyBatch: [],

  // Single item in array (common case)
  singleItemArray: [
    { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat' }
  ],

  // Mixed valid/invalid documents
  mixedValidity: [
    { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat', isValid: true },
    { type: 'sgv', sgv: 115, date: Date.now() - 300000, direction: 'Flat', isValid: false }
  ],

  // Nested extendedEmulated (AAPS pattern)
  extendedBolus: {
    eventType: 'Temp Basal',
    type: 'FAKE_EXTENDED',
    duration: 3,
    rate: 2.44,
    absolute: 2.44,
    pumpId: 4147,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    extendedEmulated: {
      eventType: 'Combo Bolus',
      duration: 3,
      splitNow: 0,
      splitExt: 100,
      enteredinsulin: 0.11,
      relative: 1.86,
      isValid: true,
      isEmulatingTempBasal: true,
      pumpId: 4147,
      pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
      pumpSerial: '33013206'
    }
  },

  // Large profileJson field (AAPS pattern)
  profileSwitch: {
    eventType: 'Profile Switch',
    profile: 'DayProfile',
    profileJson: JSON.stringify({
      units: 'mg/dl',
      dia: 5,
      sens: [{ time: '00:00', value: 45 }, { time: '12:00', value: 50 }],
      carbratio: [{ time: '00:00', value: 10 }],
      basal: [{ time: '00:00', value: 0.8 }, { time: '06:00', value: 1.0 }]
    }),
    timeshift: 0,
    percentage: 100
  }
};
```

---

## 5. API Compatibility Matrix

| Feature | API v1 | API v3 | Migration Notes |
|---------|--------|--------|-----------------|
| Batch insert | Array → `insertMany` | Single doc only | v1 must preserve batch semantics |
| Deduplication | Manual `_id` check | Built-in `isDeduplication` response | v3 handles automatically |
| Update | PUT with `_id` | PATCH with `identifier` | Different field names |
| Delete | DELETE with query | DELETE with `identifier` | v3 uses path param |
| Response format | `[{_id, ...}]` | `{identifier, isDeduplication, lastModified}` | Clients parse differently |

---

## 6. Recommendations for MongoDB Modernization

### 6.1 Must Preserve (Breaking Changes if Modified)

1. **Array batch semantics for v1 API**
   - When an array is POSTed to `/api/v1/treatments.json`, use `insertMany`
   - Return objectIds in submission order
   - Handle partial failures gracefully (some inserted, some failed)

2. **Response format for v1 API**
   - Must return array of objects with `_id` field for each submitted item
   - Format: `[{_id: "objectId1", ok: 1}, {_id: "objectId2", ok: 1}, ...]`
   - Order must match submission order (Loop depends on this for syncIdentifier mapping)
   - Deduplicated items must still return an `_id` (the existing document's ID)

3. **Deduplication response for v3 API**
   - Always return `isDeduplication` boolean
   - Include `deduplicatedIdentifier` when applicable
   - Include `lastModified` timestamp

4. **Write result translation**
   - MongoDB driver `insertMany` result format varies by driver version
   - Nightscout API layer must translate to consistent client-facing format
   - Never expose raw MongoDB write results to clients

### 6.2 Potential Driver Modernization Risks

1. **`insertMany` ordered vs unordered behavior**
   - Default changed between MongoDB driver versions
   - Ordered: stops on first error, unordered: continues and reports all errors
   - Both Loop and Trio expect all valid documents inserted even if some fail

2. **`_id` field handling**
   - Clients may pass `_id` field in some cases
   - Driver behavior for client-provided `_id` must be preserved

3. **Write acknowledgment changes**
   - Even single-doc AAPS depends on `CreateUpdateResponse` schema
   - Changes to acknowledgment format break all clients

4. **BSON size limits**
   - DeviceStatus documents with large prediction arrays approach limits
   - Test with realistic prediction array sizes (1000+ values)

### 6.3 Safe to Modernize

1. **Connection pooling** - All clients use HTTP, internal MongoDB optimization is safe
2. **Index optimization** - No client-side impact
3. **Read concern/write concern** - Can be tuned server-side (with testing)
4. **Aggregation pipelines** - For internal processing only
5. **Compression** - Wire protocol compression is transparent

### 6.4 Testing Requirements

Before any MongoDB driver update:

1. Run `storage.shape-handling.test.js` against the update
2. **New:** Run `partial-failures.js` fixtures for batch insert edge cases
3. Test with actual AAPS, Loop, and Trio clients in staging
4. Verify batch response order preservation with deduplication
5. Confirm all response format fields unchanged
6. Test large batch operations (100+ documents)
7. Test recovery from partial failures (dup key in middle of batch)

### 6.5 Suggested Test Matrix

| Test Scenario | AAPS | Loop | Trio |
|--------------|------|------|------|
| Single document insert | ✅ | N/A | N/A |
| Batch array insert | N/A | ✅ | ✅ |
| Deduplication detection | ✅ | ✅ | ✅ |
| Response format validation | ✅ | ✅ | ✅ |
| Partial failure in batch | N/A | ✅ | ✅ |
| Update existing | ✅ | ✅ | ✅ |
| Delete by identifier | ✅ | ✅ | ✅ |
| Large batch (100+ docs) | N/A | ✅ | N/A |
| Batch with some deduped | N/A | ✅ | ✅ |
| Response order preservation | N/A | ✅ | ✅ |
| Rapid sequential (throttle) | N/A | N/A | ✅ |

---

## 7. Conclusion

The three major Nightscout clients have distinct but well-defined data patterns:

- **AAPS** uses v3 API with single-doc operations, but still depends on response schema consistency
- **Loop** requires careful attention to batch semantics, response ordering, and handling of deduplicated items
- **Trio** uses v1 batching with throttling, similar concerns to Loop

**Critical insight:** All clients depend on stable response formats, not just insert behavior. Even if `insertOne` vs `insertMany` semantics are preserved, changes to the write result format or acknowledgment fields will break synchronization.

The provided test fixtures cover:
1. Client-specific data shapes (aaps, loop, trio fixtures)
2. Deduplication scenarios across all clients
3. **Partial failure and response ordering** (new critical fixture)
4. Edge cases for data validation

These should be integrated into the Nightscout CI pipeline before any MongoDB driver modernization.

---

## Appendix A: Source Code References

| Client | Key Files |
|--------|-----------|
| AAPS | `core/nssdk/NSAndroidClientImpl.kt`, `remotemodel/RemoteTreatment.kt`, `DataSyncSelectorV3.kt` |
| Loop | `NightscoutServiceKit/NightscoutService.swift`, `Extensions/NightscoutUploader.swift` |
| Trio | `Services/Network/Nightscout/NightscoutAPI.swift`, `NightscoutManager.swift` |

## Appendix B: Related Nightscout Tests

- `tests/storage.shape-handling.test.js` - Existing shape handling tests
- `tests/api.treatments.test.js` - Treatment API tests
- `tests/api.entries.test.js` - Entries API tests

## Appendix C: Fixture Files Provided

| Fixture File | Purpose |
|--------------|---------|
| `fixtures/aaps-single-doc.js` | AAPS data shapes for v3 API single-document operations |
| `fixtures/loop-batch.js` | Loop batch operations up to 1000 items |
| `fixtures/trio-pipeline.js` | Trio throttled pipeline scenarios |
| `fixtures/deduplication.js` | Deduplication scenarios for all clients |
| `fixtures/edge-cases.js` | Unicode, large documents, validation edge cases |
| `fixtures/partial-failures.js` | **Critical:** Batch insert failures, response ordering, driver result format changes |

Usage:
```javascript
const fixtures = require('./docs/60-research/fixtures');

// Access specific client fixtures
const aapsData = fixtures.aaps.smbBolus;
const loopBatch = fixtures.loop.glucoseBatch;

// Test partial failure scenarios
const partialFailure = fixtures.partialFailures.batchWithDuplicateKeyInMiddle;
```
