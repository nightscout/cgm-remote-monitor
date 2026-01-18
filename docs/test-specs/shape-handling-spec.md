# Shape Handling Test Specification

This document defines the expected behavior for single document vs array input handling across all Nightscout APIs, and the test requirements to verify this behavior.

## Overview

Nightscout supports multiple API versions and WebSocket operations for data ingestion. Each interface has slightly different behavior regarding single object vs array input handling. This specification documents:

1. Expected behavior per API/interface
2. Test requirements for each scenario
3. Known quirks and edge cases
4. MongoDB 5.x compatibility considerations

---

## API Summary

| Interface | Single Object | Array Input | Bulk Creation | Response Format |
|-----------|---------------|-------------|---------------|-----------------|
| API v1 `/api/treatments/` | ✅ Supported | ✅ Supported | ✅ Yes | Always Array |
| API v1 `/api/devicestatus/` | ✅ Supported | ✅ Supported | ✅ Yes | Always Array |
| API v1 `/api/entries/` | ✅ Supported | ✅ Supported | ✅ Yes | Always Array |
| API v3 `/api/v3/{collection}` | ✅ Supported | ❌ Not Supported | ❌ No | Single Object |
| WebSocket `dbAdd` | ✅ Supported | ✅ Supported | ✅ Yes | Always Array |

---

## API v1 Behavior Specification

### Treatments API (`/api/treatments/`)

#### Input Handling
- **Single Object**: Wrapped in array internally before processing
- **Array**: Processed as-is using `insertMany()`
- **Empty Object `{}`**: Accepted, creates document with generated fields
- **Empty Array `[]`**: Accepted, returns empty array

#### Expected Behavior
```javascript
// Single object input
POST /api/treatments/
Body: { eventType: 'Note', created_at: '2024-01-01T00:00:00Z', notes: 'test' }
Response: [{ _id: '...', eventType: 'Note', ... }]  // Always array

// Array input
POST /api/treatments/
Body: [{ eventType: 'Note', ... }, { eventType: 'BG Check', ... }]
Response: [{ _id: '...', ... }, { _id: '...', ... }]  // Array with all created docs
```

#### Test Requirements
| Test Case | Priority | Status |
|-----------|----------|--------|
| POST single object returns array | High | ✅ Covered |
| POST array with 1 element returns array | High | ✅ Covered |
| POST array with N elements returns N-length array | High | ✅ Covered |
| POST large batch (10+ items) succeeds | Medium | ✅ Covered |
| POST empty object returns array | Medium | ✅ Covered |
| POST empty array returns empty array | Medium | ✅ Covered |
| POST mixed eventTypes in array | Medium | ✅ Covered |
| All created documents have `_id` assigned | High | ✅ Covered |
| Response order matches input order | Medium | ⬜ Not covered |

### Devicestatus API (`/api/devicestatus/`)

#### Input Handling
Identical to Treatments API.

#### Test Requirements
| Test Case | Priority | Status |
|-----------|----------|--------|
| POST single object returns array | High | ✅ Covered |
| POST array with 1 element returns array | High | ✅ Covered |
| POST array with N elements returns N-length array | High | ✅ Covered |
| POST large batch (10+ items) succeeds | Medium | ✅ Covered |
| POST empty object returns array | Medium | ✅ Covered |
| POST empty array returns empty array | Medium | ✅ Covered |

### Entries API (`/api/entries/`)

#### Input Handling
- Uses `insert_entries` middleware which checks for both single and array
- Single object detected by presence of `date` field
- Array detected by `length` property
- Both can be combined (single + array in same request)

#### Expected Behavior
```javascript
// Single object input (must have 'date' field)
POST /api/entries/
Body: { type: 'sgv', sgv: 120, date: 1704067200000 }
Response: [{ _id: '...', type: 'sgv', sgv: 120, ... }]

// Array input
POST /api/entries/
Body: [{ type: 'sgv', sgv: 120, date: 1704067200000 }, { type: 'sgv', sgv: 125, date: 1704067500000 }]
Response: [{ _id: '...', ... }, { _id: '...', ... }]
```

#### Test Requirements
| Test Case | Priority | Status |
|-----------|----------|--------|
| POST single SGV entry returns array | High | ✅ Covered |
| POST array of SGV entries returns array | High | ✅ Covered |
| POST single MBG entry returns array | Medium | ✅ Covered |
| POST mixed entry types in array | Medium | ✅ Covered |
| POST large batch entries | Medium | ✅ Covered |
| POST empty array returns empty array | Medium | ✅ Covered |
| Response order matches input order | Medium | ⬜ Not covered |

---

## API v3 Behavior Specification

### All Collections (`/api/v3/{collection}`)

#### Input Handling
- **Single Object Only**: API v3 only accepts single document per POST
- **Array Input**: Returns 400 Bad Request
- Uses identifier-based deduplication

#### Expected Behavior
```javascript
// Single object input
POST /api/v3/treatments
Body: { date: 1704067200000, eventType: 'Note', insulin: 0.3, device: 'test' }
Response: { status: 201, identifier: '...', lastModified: ... }

// Array input - NOT SUPPORTED
POST /api/v3/treatments
Body: [{ date: ..., ... }, { date: ..., ... }]
Response: { status: 400, message: 'Bad or missing...' }
```

#### Test Requirements
| Test Case | Priority | Status |
|-----------|----------|--------|
| POST single object succeeds (201) | High | ✅ Covered |
| POST array input returns 400 | High | ✅ Covered |
| POST empty object returns 400 | High | ✅ Covered |
| POST empty array returns 400 | Medium | ✅ Covered |
| Identifier correctly calculated | High | ✅ Covered |
| Deduplication works on re-POST | High | ✅ Covered |
| Response format is object not array | Medium | ✅ Covered |

---

## WebSocket Behavior Specification

### dbAdd Operation

#### Input Handling
- Accepts both single object and array via `data` field
- Internally normalizes to array before storage
- Returns array of created documents

#### Expected Behavior
```javascript
// Single object
socket.emit('dbAdd', {
  collection: 'treatments',
  data: { eventType: 'Note', created_at: '2024-01-01T00:00:00Z', notes: 'test' }
}, callback);
// callback receives: [{ _id: '...', eventType: 'Note', ... }]

// Array
socket.emit('dbAdd', {
  collection: 'treatments',
  data: [{ eventType: 'Note', ... }, { eventType: 'BG Check', ... }]
}, callback);
// callback receives: [{ _id: '...', ... }, { _id: '...', ... }]
```

#### Test Requirements
| Test Case | Priority | Status |
|-----------|----------|--------|
| dbAdd single object for treatments | High | ✅ Covered |
| dbAdd array for treatments | High | ✅ Covered |
| dbAdd single object for devicestatus | High | ✅ Covered |
| dbAdd array for devicestatus | High | ✅ Covered |
| dbAdd single object for entries | High | ✅ Covered |
| dbAdd array for entries | High | ✅ Covered |
| dbUpdate modifies single document | Medium | ✅ Covered |
| dbRemove deletes single document | Medium | ✅ Covered |

---

## Storage Layer Behavior Specification

### treatments.create()

```javascript
// Normalizes input to array
function create(treatments, callback) {
  if (!Array.isArray(treatments)) {
    treatments = [treatments];  // Wrap single object
  }
  // Use insertMany for array
}
```

### devicestatus.create()

Same normalization pattern as treatments.

### entries.create()

Expects array input; single objects should be wrapped by caller.

---

## MongoDB 5.x Compatibility Considerations

### insertOne vs insertMany

The MongoDB 5.x driver has stricter typing. Key behaviors:

| Operation | Input | Behavior |
|-----------|-------|----------|
| `insertOne(object)` | Object | Inserts single document ✅ |
| `insertOne(array)` | Array | **Creates single document containing array** ❌ |
| `insertMany(array)` | Array | Inserts each element as separate document ✅ |
| `insertMany(object)` | Object | Error - expects array |

#### Test Requirements for MongoDB Compatibility
| Test Case | Priority | Status |
|-----------|----------|--------|
| insertOne with object creates 1 document | High | ✅ Covered |
| insertOne with array behavior documented | High | ✅ Covered |
| insertMany with array creates N documents | High | ✅ Covered |
| Storage layer prevents insertOne with array | High | ✅ Covered |

---

## Concurrent Write / Race Condition Tests

### Scenarios to Test

| Scenario | Priority | Status |
|----------|----------|--------|
| Simultaneous POST to same collection | High | ✅ Covered |
| Rapid sequential POSTs (10 in 100ms) | High | ✅ Covered |
| Simultaneous array batch POSTs | High | ✅ Covered |
| Cross-collection concurrent writes | Medium | ✅ Covered |
| Unique _id after concurrent inserts | High | ✅ Covered |
| Response count matches request count | High | ✅ Covered |
| AAPS sync catch-up (50 SMB POSTs) | High | ✅ Covered |
| AAPS sync catch-up (100 SGV POSTs) | High | ✅ Covered |
| Cross-collection concurrent sync | Medium | ✅ Covered |
| WebSocket + API concurrent writes | Medium | ⬜ Not covered |
| Duplicate identifier handling under load | Medium | ⬜ Not covered |

---

## AAPS-Realistic Pattern Tests

Based on analysis of AndroidAPS source code. See `tests/fixtures/aaps-patterns.json` for fixture data.

### API v3 Deduplication Tests

The identifier is calculated from `device + date + eventType`. Note: `pumpId`, `pumpType`, `pumpSerial` are stored but NOT used in identifier calculation.

| Test Case | Status |
|-----------|--------|
| New treatment returns 201 | ✅ Covered |
| Duplicate (same device+date+eventType) returns 200 | ✅ Covered |
| Different pumpId, same identifier triggers dedup | ✅ Covered |
| Different date creates new treatment (201) | ✅ Covered |
| Different eventType creates new treatment (201) | ✅ Covered |

### SMB Burst Pattern Tests

Tests rapid sequential Super Micro Bolus insertions (common in closed-loop systems).

| Test Case | Status |
|-----------|--------|
| Sequential SMB corrections with unique identifiers | ✅ Covered |

### Meal Scenario Tests

Tests typical meal-related treatments: carb entry, bolus wizard, meal bolus.

| Test Case | Status |
|-----------|--------|
| All meal treatments have unique identifiers | ✅ Covered |

### SGV Entry Pattern Tests

Tests high-frequency glucose readings (5-minute intervals).

| Test Case | Status |
|-----------|--------|
| Sequential SGV entries with unique identifiers | ✅ Covered |

### Expected Behavior
- All writes should succeed or fail atomically
- No data corruption or partial writes
- Duplicate identifiers handled via upsert/dedup logic
- Response count should match successfully written documents

---

## Cross-API Consistency Tests

### Verification Requirements

| Test Case | Priority | Status |
|-----------|----------|--------|
| Same treatment via API v1 and WebSocket produces identical storage | Medium | ⬜ Not covered |
| Document created via API v1 readable via API v3 | Medium | ⬜ Not covered |
| Document created via API v3 readable via API v1 | Medium | ⬜ Not covered |
| Field normalization consistent across APIs | Low | ⬜ Not covered |

---

## Edge Cases and Known Quirks

### 1. Empty Array Handling
- API v1: Returns empty array `[]` - no error
- API v3: Not applicable (single doc only)
- WebSocket: Returns empty array `[]`

### 2. Null/Undefined in Array
```javascript
// Input with null element
POST /api/treatments/
Body: [{ eventType: 'Note', ... }, null, { eventType: 'BG Check', ... }]
// Behavior: Should skip null elements or error (TBD - needs test)
```

### 3. Very Large Batches
- No explicit limit in code
- MongoDB default batch limit applies
- Performance degrades with >1000 items
- Recommended: Test with 100, 500, 1000 items

### 4. Response Order
- Not guaranteed to match input order for all APIs
- MongoDB insertMany maintains order
- Needs verification tests

---

## Test File Organization

| File | Coverage Area |
|------|---------------|
| `tests/api.shape-handling.test.js` | API v1 treatments, devicestatus, entries |
| `tests/api3.shape-handling.test.js` | API v3 all collections |
| `tests/storage.shape-handling.test.js` | Storage layer direct tests |
| `tests/websocket.shape-handling.test.js` | WebSocket dbAdd/dbUpdate/dbRemove |
| `tests/concurrent-writes.test.js` | Race conditions and concurrent access |

---

## Running Shape Handling Tests

```bash
# Run all shape handling tests
npm test -- --grep "Shape Handling"

# Run specific test file
npm test -- tests/api.shape-handling.test.js

# Run with verbose output
npm test -- --grep "Shape Handling" --reporter spec
```

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-18 | Initial specification created based on code analysis |
