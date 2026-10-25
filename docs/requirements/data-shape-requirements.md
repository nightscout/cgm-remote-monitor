# Data Shape Requirements Specification

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft  
**Related Audits:** [API Layer Audit](../audits/api-layer-audit.md), [Data Layer Audit](../audits/data-layer-audit.md)

---

## 1. Purpose

This document formally specifies the requirements for data shape handling across Nightscout's REST API, WebSocket, and storage layers. It serves as a contract for:

1. **Client developers** - Knowing what input shapes are supported
2. **Maintainers** - Preserving backward compatibility during refactoring
3. **Testers** - Validating behavior against formal requirements
4. **Migration planners** - Understanding what must be preserved during MongoDB driver upgrades

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **Single Object** | A JSON object representing one document: `{ "field": "value" }` |
| **Array Input** | A JSON array containing one or more objects: `[{ "field": "value" }]` |
| **Batch** | An array containing multiple objects for bulk insertion |
| **Shape** | The structural format of input or output data (single vs array) |
| **Normalization** | Converting diverse input shapes to a consistent internal format |

---

## 3. Requirements by Interface

### 3.1 REST API v1 Requirements

#### REQ-API-001: Input Shape Flexibility

The API v1 POST endpoints MUST accept both single objects and arrays as valid input for the following collections:

| Collection | Single Object | Array | Requirement ID |
|------------|---------------|-------|----------------|
| `/api/v1/treatments` | MUST accept | MUST accept | REQ-API-001a |
| `/api/v1/entries` | MUST accept | MUST accept | REQ-API-001b |
| `/api/v1/devicestatus` | MUST accept | MUST accept | REQ-API-001c |
| `/api/v1/profile` | MUST accept | Single only (typical) | REQ-API-001d |
| `/api/v1/food` | MUST accept | Single only (typical) | REQ-API-001e |
| `/api/v1/activity` | NOT supported | MUST accept (array required) | REQ-API-001f |

**Rationale:** AAPS, Loop, and xDrip clients may send either format for treatments/entries/devicestatus based on whether they're uploading a single reading or batch-syncing historical data. Profile and food are typically single-document operations; activity requires array input by design.

#### REQ-API-002: Response Shape Consistency

All successful POST responses MUST return an array, regardless of input shape:

```
Input: { "sgv": 120 }
Output: [{ "_id": "...", "sgv": 120 }]

Input: [{ "sgv": 120 }, { "sgv": 125 }]
Output: [{ "_id": "...", "sgv": 120 }, { "_id": "...", "sgv": 125 }]
```

**Rationale:** Consistent response shapes simplify client-side parsing logic.

#### REQ-API-003: Empty Input Handling

| Input | Expected Behavior | Requirement ID |
|-------|-------------------|----------------|
| Empty object `{}` | Return empty array `[]` (no database write) | REQ-API-003a |
| Empty array `[]` | Return empty array `[]` (no database write) | REQ-API-003b |

#### REQ-API-004: Batch Size Support

The API MUST support batch inserts of at least 100 documents in a single request without data loss or timeout.

**Test Reference:** `tests/api.shape-handling.test.js` - "handles large batch array"

---

### 3.2 WebSocket Requirements

#### REQ-WS-001: dbAdd Input Shapes

The WebSocket `dbAdd` message handler MUST accept both single objects and arrays:

| Collection | Single Object | Array | Requirement ID |
|------------|---------------|-------|----------------|
| `treatments` | MUST accept | MUST accept | REQ-WS-001a |
| `devicestatus` | MUST accept | MUST accept | REQ-WS-001b |
| `entries` | MUST accept | MUST accept | REQ-WS-001c |

**Implementation Note:** Array inputs are processed sequentially to ensure each document gets a unique `_id` and triggers appropriate events.

#### REQ-WS-002: dbAdd Response Shape

The callback response for `dbAdd` MUST return an array of created documents:

```javascript
socket.emit('dbAdd', { collection: 'treatments', data: singleObj }, (result) => {
  // result is always an array: [{ _id, ...singleObj }]
});
```

#### REQ-WS-003: Event Emission

Each successful document insertion via `dbAdd` MUST:
1. Emit a `data-update` event on the internal bus
2. Emit a `data-received` event after all insertions complete

#### REQ-WS-004: MongoDB insertOne Behavior

The implementation MUST NOT pass arrays directly to `insertOne()`. Arrays MUST be iterated and each item inserted individually.

**Rationale:** MongoDB's `insertOne([a, b])` creates a single document `{0: a, 1: b}`, not multiple documents. This was identified as a bug during MongoDB 5.x migration testing.

---

### 3.3 Storage Layer Requirements

#### REQ-STORAGE-001: Collection-Specific Shape Support

| Collection | Single Object | Array | Normalization | Requirement ID |
|------------|---------------|-------|---------------|----------------|
| `treatments` | MUST accept | MUST accept | Wrap single in array | REQ-STORAGE-001a |
| `devicestatus` | MUST accept | MUST accept | Wrap single in array | REQ-STORAGE-001b |
| `entries` | MUST accept | MUST accept | Auto-detected | REQ-STORAGE-001c |
| `profile` | MUST accept | N/A | Single only | REQ-STORAGE-001d |
| `food` | MUST accept | N/A | Single only | REQ-STORAGE-001e |
| `activity` | NOT supported | MUST accept | Array only | REQ-STORAGE-001f |

#### REQ-STORAGE-002: Timestamp Normalization

The storage layer MUST add a `created_at` timestamp to documents that lack one:

```javascript
if (!doc.created_at) {
  doc.created_at = new Date().toISOString();
}
```

#### REQ-STORAGE-003: Sequential Processing

When processing arrays, the storage layer MUST:
1. Process documents sequentially (not in parallel)
2. Stop on first error OR complete all insertions
3. Return all successfully created documents

**Rationale:** Sequential processing prevents race conditions with closure variables in async callbacks.

---

## 4. Error Handling Requirements

#### REQ-ERR-001: Partial Failure Semantics

| Scenario | Expected Behavior |
|----------|-------------------|
| Single object fails | Return error, no documents created |
| One item in array fails | Implementation-specific (see notes) |
| All items fail | Return error, no documents created |

**Note:** Current implementation varies by endpoint. REST API may return partial success; WebSocket continues processing remaining items. This should be standardized in future versions.

#### REQ-ERR-002: Error Response Format

Error responses SHOULD include:
- HTTP status code (for REST API)
- Error message describing the failure
- Optional: identifier of failed document (for batch operations)

---

## 5. Performance Requirements

#### REQ-PERF-001: Batch Processing Efficiency

Batch inserts SHOULD use efficient database operations:
- For arrays ≤10 items: Sequential `insertOne()` acceptable
- For arrays >10 items: Consider `insertMany()` or bulk operations

**Current Status:** All implementations use sequential insertion. Optimization opportunity identified.

#### REQ-PERF-002: Update Throttling

The `data-received` event triggering data updates is throttled to 15 seconds (`UPDATE_THROTTLE` in `bootevent.js`). This is intentional to reduce database load.

---

## 6. Traceability Matrix

| Requirement | Test File | Test Case | Status |
|-------------|-----------|-----------|--------|
| REQ-API-001a | `api.shape-handling.test.js` | "treatments POST accepts single/array" | Covered |
| REQ-API-001b | `api.shape-handling.test.js` | Entries tests (via API tests) | Covered |
| REQ-API-001c | `api.shape-handling.test.js` | "devicestatus POST accepts single/array" | Covered |
| REQ-API-001d | `storage.shape-handling.test.js` | "profile create() accepts single" | Covered |
| REQ-API-001e | `storage.shape-handling.test.js` | "food create() accepts single" | Covered |
| REQ-API-001f | `storage.shape-handling.test.js` | "activity create() array only" | Covered |
| REQ-API-002 | `api.shape-handling.test.js` | "single object input returns array response" | Covered |
| REQ-API-003 | `api.shape-handling.test.js` | "POST with empty object/array" | Covered |
| REQ-API-004 | `api.shape-handling.test.js` | "handles large batch array" | Covered |
| REQ-WS-001 | `websocket.shape-handling.test.js` | "dbAdd accepts single/array" | Covered |
| REQ-WS-002 | `websocket.shape-handling.test.js` | Callback response validation | Implicit |
| REQ-WS-003 | `websocket.shape-handling.test.js` | Event emission on dbAdd | Implicit |
| REQ-WS-004 | `websocket.shape-handling.test.js` | "dbAdd with array input" | Covered |
| REQ-STORAGE-001 | `storage.shape-handling.test.js` | "create() accepts single/array" | Covered |
| REQ-STORAGE-002 | `storage.shape-handling.test.js` | Timestamp added (implicit) | Partial |
| REQ-STORAGE-003 | `storage.shape-handling.test.js` | "handles large batch" | Covered |
| REQ-ERR-001 | N/A | Partial failure semantics | Future |
| REQ-ERR-002 | N/A | Error response format | Future |
| REQ-PERF-001 | N/A | Batch efficiency | Aspirational |
| REQ-PERF-002 | N/A | Throttling (design doc) | Documented |

---

## 7. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Nightscout Team | Initial specification based on MongoDB 5.x migration testing |

---

## 8. References

- [API Layer Audit](../audits/api-layer-audit.md) - Endpoint inventory and response formats
- [Data Layer Audit](../audits/data-layer-audit.md) - MongoDB collection schemas
- [Shape Handling Tests](../test-specs/shape-handling-tests.md) - Detailed test cases
- [API v1 Compatibility Requirements](./api-v1-compatibility-requirements.md) - Client compatibility requirements
