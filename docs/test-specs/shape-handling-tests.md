# Shape Handling Test Specification

**Document Version:** 2.0  
**Last Updated:** January 2026  
**Status:** Active  
**Related Requirements:** [Data Shape Requirements](../requirements/data-shape-requirements.md)

---

## Progress & Coverage Status

### Current State

| Metric | Value |
|--------|-------|
| Total Tests | 38+ (core) + concurrent/AAPS suites |
| Coverage Status | High coverage for core paths |
| Last Test Run | January 2026 |
| Known Regressions | None |

### Recent Discoveries

| Date | Discovery | Impact | Source |
|------|-----------|--------|--------|
| 2026-01-18 | API v3 identifier calculated from `device + date + eventType` only | `pumpId`, `pumpType`, `pumpSerial` NOT used in dedup | Code review |
| 2026-01-18 | AAPS sends documents one-at-a-time to API v3 | "Batch handling" is about rapid sequential requests, not array POSTs | Code review |
| 2026-01-15 | WebSocket `insertOne()` with array creates single doc | MongoDB driver behavior, fixed via array detection | `lib/server/websocket.js` |
| 2026-01-15 | devicestatus.js had race condition with arrays | Fixed via `async.eachSeries()` | PR #8314 |
| 2026-01-15 | `eventType` defaults to `<none>` if missing | Treatments always have eventType | `lib/server/websocket.js:357-358` |

### Coverage Gaps (Prioritized)

| Gap | Priority | Blocking Issue |
|-----|----------|----------------|
| Response order matches input order | Medium | Needs verification tests |
| WebSocket + API concurrent writes | Medium | Complex test setup |
| Duplicate identifier handling under load | Medium | Needs stress test harness |
| Cross-API consistency (v1 vs v3 storage) | Medium | Need cross-read verification |
| Null/undefined in array handling | Low | Edge case, behavior TBD |

### Test Execution

```bash
npm test -- --grep "Shape Handling"
npm test -- tests/api.shape-handling.test.js
npm test -- tests/api3.shape-handling.test.js
npm test -- tests/concurrent-writes.test.js
npm test -- tests/api3.aaps-patterns.test.js
```

---

## 1. Overview

Nightscout supports multiple API versions and WebSocket operations for data ingestion. Each interface has different behavior regarding single object vs array input handling. This specification documents:

1. Expected behavior per API/interface
2. Test requirements for each scenario
3. Known quirks and edge cases
4. MongoDB 5.x compatibility considerations

---

## 2. API Behavior Summary

| Interface | Single Object | Array Input | Bulk Creation | Response Format |
|-----------|---------------|-------------|---------------|-----------------|
| API v1 `/api/treatments/` | Supported | Supported | Yes | Always Array |
| API v1 `/api/devicestatus/` | Supported | Supported | Yes | Always Array |
| API v1 `/api/entries/` | Supported | Supported | Yes | Always Array |
| API v3 `/api/v3/{collection}` | Supported | Rejected (400) | No | Single Object |
| WebSocket `dbAdd` | Supported | Supported | Yes | Always Array |

---

## 3. Test Files

| File | Coverage Area | Test Count |
|------|---------------|------------|
| `tests/api.shape-handling.test.js` | REST API v1 shape handling | 18 |
| `tests/api3.shape-handling.test.js` | API v3 all collections | 8 |
| `tests/websocket.shape-handling.test.js` | WebSocket dbAdd operations | 10 |
| `tests/storage.shape-handling.test.js` | Direct storage layer tests | 10 |
| `tests/concurrent-writes.test.js` | Race conditions, AAPS sync | 12 |
| `tests/api3.aaps-patterns.test.js` | AAPS-realistic patterns | 8 |
| `tests/fixtures/aaps-patterns.json` | Test fixtures | N/A |

---

## 4. REST API v1 Test Cases

### 4.1 Treatments Endpoint

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| API-T-001 | POST single treatment object | REQ-API-001a | 200 OK, array with 1 document | Covered |
| API-T-002 | POST array with single treatment | REQ-API-001a | 200 OK, array with 1 document | Covered |
| API-T-003 | POST array with multiple treatments | REQ-API-001a | 200 OK, array with N documents | Covered |
| API-T-004 | POST large batch (50+ treatments) | REQ-API-004 | 200 OK, all documents created | Covered |
| API-T-005 | Response shape: single input | REQ-API-002 | Response is array | Covered |
| API-T-006 | Response shape: array input | REQ-API-002 | Response is array | Covered |
| API-T-007 | POST empty object | REQ-API-003a | 200 OK, empty array | Covered |
| API-T-008 | POST empty array | REQ-API-003b | 200 OK, empty array | Covered |
| API-T-009 | POST mixed eventTypes in array | REQ-API-001a | All types preserved | Covered |
| API-T-010 | Response order matches input order | REQ-API-005 | Order preserved | **Not Covered** |

#### Input Handling
- **Single Object**: Wrapped in array internally before processing
- **Array**: Processed as-is using `insertMany()`
- **Empty Object `{}`**: Accepted, creates document with generated fields
- **Empty Array `[]`**: Accepted, returns empty array

### 4.2 Devicestatus Endpoint

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| API-D-001 | POST single devicestatus object | REQ-API-001c | 200 OK, array with 1 document | Covered |
| API-D-002 | POST array with single devicestatus | REQ-API-001c | 200 OK, array with 1 document | Covered |
| API-D-003 | POST array with multiple devicestatus | REQ-API-001c | 200 OK, array with N documents | Covered |
| API-D-004 | POST large batch (50+ devicestatus) | REQ-API-004 | 200 OK, all documents created | Covered |
| API-D-005 | Response shape: single input | REQ-API-002 | Response is array | Covered |
| API-D-006 | Response shape: array input | REQ-API-002 | Response is array | Covered |
| API-D-007 | POST empty object | REQ-API-003a | 200 OK, empty array | Covered |
| API-D-008 | POST empty array | REQ-API-003b | 200 OK, empty array | Covered |

**Known Issue (Fixed):** Prior to MongoDB 5.x migration fix, `devicestatus.create()` had a race condition when processing arrays. Fixed via `async.eachSeries()`.

### 4.3 Entries Endpoint

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| API-E-001 | POST single SGV entry | REQ-API-001b | 200 OK, array with 1 document | Covered |
| API-E-002 | POST array of SGV entries | REQ-API-001b | 200 OK, array with N documents | Covered |
| API-E-003 | POST single MBG entry | REQ-API-001b | 200 OK, array with 1 document | Covered |
| API-E-004 | POST mixed entry types | REQ-API-001b | All types preserved | Covered |
| API-E-005 | POST large batch entries | REQ-API-004 | All entries created | Covered |
| API-E-006 | POST empty array | REQ-API-003b | 200 OK, empty array | Covered |
| API-E-007 | Response order matches input | REQ-API-005 | Order preserved | **Not Covered** |

---

## 5. REST API v3 Test Cases

### 5.1 All Collections

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| API3-001 | POST single object succeeds | REQ-API3-001 | 201 Created | Covered |
| API3-002 | POST array input returns 400 | REQ-API3-002 | 400 Bad Request | Covered |
| API3-003 | POST empty object returns 400 | REQ-API3-003 | 400 Bad Request | Covered |
| API3-004 | POST empty array returns 400 | REQ-API3-003 | 400 Bad Request | Covered |
| API3-005 | Identifier correctly calculated | REQ-API3-004 | device+date+eventType hash | Covered |
| API3-006 | Deduplication on re-POST | REQ-API3-005 | 200 OK (not 201) | Covered |
| API3-007 | Response format is object | REQ-API3-006 | Single object, not array | Covered |

### 5.2 Identifier Calculation (Important)

The identifier is calculated from: **`device + date + eventType`**

Fields that are stored but **NOT** used in identifier calculation:
- `pumpId`
- `pumpType`
- `pumpSerial`

This means documents with different pump fields but same device+date+eventType will be treated as duplicates.

---

## 6. WebSocket Test Cases

### 6.1 dbAdd Operations

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| WS-001 | dbAdd single treatment | REQ-WS-001a | Document created, callback with array | Covered |
| WS-002 | dbAdd array of treatments | REQ-WS-001a | All documents created | Covered |
| WS-003 | dbAdd single devicestatus | REQ-WS-001b | Document created, callback with array | Covered |
| WS-004 | dbAdd array of devicestatus | REQ-WS-001b | All documents created | Covered |
| WS-005 | dbAdd single entry | REQ-WS-001c | Document created, callback with array | Covered |
| WS-006 | dbAdd array of entries | REQ-WS-001c | All documents created | Covered |
| WS-007 | Callback response shape | REQ-WS-002 | Always returns array | Covered |
| WS-008 | Event emission | REQ-WS-003 | data-update and data-received emitted | Covered |
| WS-009 | dbUpdate single treatment | N/A | Document updated | Covered |
| WS-010 | dbRemove single treatment | N/A | Document deleted | Covered |

**Known Issue (Fixed):** WebSocket `dbAdd` used `insertOne()` with array input, creating a single document containing the array. Fixed via array detection and `processSingleDbAdd()` helper.

---

## 7. Storage Layer Test Cases

### 7.1 Treatments Storage

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| STG-T-001 | create() with single object | REQ-STORAGE-001a | Document created | Covered |
| STG-T-002 | create() with single-element array | REQ-STORAGE-001a | Document created | Covered |
| STG-T-003 | create() with multi-element array | REQ-STORAGE-001a | All documents created | Covered |
| STG-T-004 | create() with large batch (100+) | REQ-STORAGE-003 | All documents created | Covered |

### 7.2 Devicestatus Storage

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| STG-D-001 | create() with single object | REQ-STORAGE-001b | Document created | Covered |
| STG-D-002 | create() with single-element array | REQ-STORAGE-001b | Document created | Covered |
| STG-D-003 | create() with multi-element array | REQ-STORAGE-001b | All documents created | Covered |
| STG-D-004 | create() with large batch (100+) | REQ-STORAGE-003 | All documents created | Covered |

### 7.3 Entries Storage

| Test ID | Test Case | Requirement | Expected Result | Status |
|---------|-----------|-------------|-----------------|--------|
| STG-E-001 | create() with single entry in array | REQ-STORAGE-001c | Entry created | Covered |
| STG-E-002 | create() with multi-entry array | REQ-STORAGE-001c | All entries created | Covered |

---

## 8. Concurrent Write / Race Condition Tests

### 8.1 Standard Concurrency

| Test ID | Scenario | Priority | Status |
|---------|----------|----------|--------|
| CONC-001 | Simultaneous POST to same collection | High | Covered |
| CONC-002 | Rapid sequential POSTs (10 in 100ms) | High | Covered |
| CONC-003 | Simultaneous array batch POSTs | High | Covered |
| CONC-004 | Cross-collection concurrent writes | Medium | Covered |
| CONC-005 | Unique _id after concurrent inserts | High | Covered |
| CONC-006 | Response count matches request count | High | Covered |
| CONC-007 | WebSocket + API concurrent writes | Medium | **Not Covered** |
| CONC-008 | Duplicate identifier under load | Medium | **Not Covered** |

### 8.2 AAPS Sync Catch-up Scenarios

| Test ID | Scenario | Priority | Status |
|---------|----------|----------|--------|
| AAPS-001 | 50 SMB POSTs in rapid succession | High | Covered |
| AAPS-002 | 100 SGV POSTs in rapid succession | High | Covered |
| AAPS-003 | Cross-collection concurrent sync | Medium | Covered |

---

## 9. AAPS-Realistic Pattern Tests

Based on analysis of AndroidAPS source code. See `tests/fixtures/aaps-patterns.json` for fixture data.

### 9.1 Deduplication Tests

| Test ID | Test Case | Status |
|---------|-----------|--------|
| AAPS-DUP-001 | New treatment returns 201 | Covered |
| AAPS-DUP-002 | Duplicate (same device+date+eventType) returns 200 | Covered |
| AAPS-DUP-003 | Different pumpId, same identifier triggers dedup | Covered |
| AAPS-DUP-004 | Different date creates new treatment (201) | Covered |
| AAPS-DUP-005 | Different eventType creates new treatment (201) | Covered |

### 9.2 srvModified Timestamp Verification

The test `rapid duplicate submissions result in single persisted document with latest srvModified` verifies:
1. **Timestamp Progression**: Uses strict `greaterThan` assertions (not `greaterThanOrEqual`)
2. **Persisted Matches API Response**: Exact equality check on final `srvModified`
3. **Document Uniqueness**: Verified via both identifier-based and device+date searches
4. **Cross-validation**: Both search methods return identical results

### 9.3 Pattern Tests

| Test ID | Pattern | Status |
|---------|---------|--------|
| AAPS-PAT-001 | Sequential SMB corrections with unique identifiers | Covered |
| AAPS-PAT-002 | Meal scenario (carbs + bolus wizard + bolus) | Covered |
| AAPS-PAT-003 | High-frequency SGV entries (5-min intervals) | Covered |

---

## 10. MongoDB 5.x Compatibility

### 10.1 insertOne vs insertMany

| Operation | Input | Behavior |
|-----------|-------|----------|
| `insertOne(object)` | Object | Inserts single document |
| `insertOne(array)` | Array | **Creates single document containing array** |
| `insertMany(array)` | Array | Inserts each element as separate document |
| `insertMany(object)` | Object | Error - expects array |

| Test ID | Test Case | Status |
|---------|-----------|--------|
| MONGO-001 | insertOne with object creates 1 document | Covered |
| MONGO-002 | insertOne with array behavior documented | Covered |
| MONGO-003 | insertMany with array creates N documents | Covered |
| MONGO-004 | Storage layer prevents insertOne with array | Covered |

---

## 11. Edge Cases

### 11.1 Empty Input

| Test ID | Input | Expected Result | Status |
|---------|-------|-----------------|--------|
| EDGE-001 | `{}` | Empty array response | Covered |
| EDGE-002 | `[]` | Empty array response | Covered |
| EDGE-003 | `null` | Error or empty array | **Not Covered** |
| EDGE-004 | `undefined` | Error or empty array | **Not Covered** |

### 11.2 Array with Invalid Elements

| Test ID | Input | Expected Result | Status |
|---------|-------|-----------------|--------|
| EDGE-005 | Array with null element | TBD | **Not Covered** |
| EDGE-006 | Array with undefined element | TBD | **Not Covered** |

### 11.3 Very Large Batches

- No explicit limit in code
- MongoDB default batch limit applies
- Performance degrades with >1000 items
- Tested: 100, 500 items

---

## 12. Cross-API Consistency Tests

| Test ID | Test Case | Priority | Status |
|---------|-----------|----------|--------|
| CROSS-001 | Same treatment via API v1 and WebSocket produces identical storage | Medium | **Not Covered** |
| CROSS-002 | Document created via API v1 readable via API v3 | Medium | **Not Covered** |
| CROSS-003 | Document created via API v3 readable via API v1 | Medium | **Not Covered** |
| CROSS-004 | Field normalization consistent across APIs | Low | **Not Covered** |

---

## 13. Coverage Matrix

| Requirement | Test ID(s) | Status |
|-------------|------------|--------|
| REQ-API-001a | API-T-001 to API-T-004 | Covered |
| REQ-API-001b | API-E-001 to API-E-005 | Covered |
| REQ-API-001c | API-D-001 to API-D-004 | Covered |
| REQ-API-002 | API-T-005, API-T-006, API-D-005, API-D-006 | Covered |
| REQ-API-003 | API-T-007, API-T-008, API-D-007, API-D-008 | Covered |
| REQ-API-004 | API-T-004, API-D-004 | Covered |
| REQ-API3-001 to 006 | API3-001 to API3-007 | Covered |
| REQ-WS-001 | WS-001 to WS-006 | Covered |
| REQ-WS-002 | WS-007 | Covered |
| REQ-WS-003 | WS-008 | Covered |
| REQ-STORAGE-001 | STG-T-*, STG-D-*, STG-E-* | Covered |
| REQ-STORAGE-003 | STG-T-004, STG-D-004 | Covered |

---

## 14. Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2026-01-18 | Consolidated from two documents, added Progress section, AAPS patterns, concurrent tests |
| 1.0 | 2026-01-15 | Initial specification |

---

## 15. References

- [Data Shape Requirements](../requirements/data-shape-requirements.md)
- [API v1 Compatibility Requirements](../requirements/api-v1-compatibility-requirements.md)
- [API Layer Audit](../audits/api-layer-audit.md)
- Test files in `tests/` directory
