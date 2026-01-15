# Shape Handling Test Specification

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft  
**Related Requirements:** [Data Shape Requirements](../requirements/data-shape-requirements.md)

---

## 1. Purpose

This document specifies the test cases for validating data shape handling across Nightscout's API, WebSocket, and storage layers. Each test case is linked to a formal requirement and mapped to actual test implementations.

---

## 2. Test Suite Overview

### 2.1 Test Files

| File | Purpose | Test Count |
|------|---------|------------|
| `tests/api.shape-handling.test.js` | REST API v1 shape handling | 18 |
| `tests/websocket.shape-handling.test.js` | WebSocket dbAdd operations | 10 |
| `tests/storage.shape-handling.test.js` | Direct storage layer tests | 10 |
| **Total** | | **38** |

### 2.2 Test Execution

```bash
# Run all shape handling tests
npm test -- --grep "Shape Handling"

# Run specific suite
npm test -- --grep "API Shape Handling"
npm test -- --grep "WebSocket Shape"
npm test -- --grep "Storage Layer Shape"
```

---

## 3. REST API Test Cases

### 3.1 Treatments Endpoint

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| API-T-001 | POST single treatment object | REQ-API-001a | 200 OK, array with 1 document |
| API-T-002 | POST array with single treatment | REQ-API-001a | 200 OK, array with 1 document |
| API-T-003 | POST array with multiple treatments | REQ-API-001a | 200 OK, array with N documents |
| API-T-004 | POST large batch (50+ treatments) | REQ-API-004 | 200 OK, all documents created |
| API-T-005 | Response shape: single input | REQ-API-002 | Response is array |
| API-T-006 | Response shape: array input | REQ-API-002 | Response is array |
| API-T-007 | POST empty object | REQ-API-003a | 200 OK, empty array |
| API-T-008 | POST empty array | REQ-API-003b | 200 OK, empty array |

#### Test Case Details

**API-T-001: POST single treatment object**
```javascript
it('POST accepts single object', function (done) {
  request(self.app)
    .post('/api/v1/treatments')
    .set('api-secret', self.apiSecret)
    .send({ eventType: 'Note', notes: 'test' })
    .expect(200)
    .expect(function (res) {
      res.body.should.be.an.Array();
      res.body.length.should.equal(1);
    })
    .end(done);
});
```

**API-T-004: POST large batch**
```javascript
it('POST handles large batch array', function (done) {
  var batch = [];
  for (var i = 0; i < 50; i++) {
    batch.push({ eventType: 'Note', notes: 'batch ' + i });
  }
  
  request(self.app)
    .post('/api/v1/treatments')
    .set('api-secret', self.apiSecret)
    .send(batch)
    .expect(200)
    .expect(function (res) {
      res.body.length.should.equal(50);
    })
    .end(done);
});
```

### 3.2 Devicestatus Endpoint

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| API-D-001 | POST single devicestatus object | REQ-API-001c | 200 OK, array with 1 document |
| API-D-002 | POST array with single devicestatus | REQ-API-001c | 200 OK, array with 1 document |
| API-D-003 | POST array with multiple devicestatus | REQ-API-001c | 200 OK, array with N documents |
| API-D-004 | POST large batch (50+ devicestatus) | REQ-API-004 | 200 OK, all documents created |
| API-D-005 | Response shape: single input | REQ-API-002 | Response is array |
| API-D-006 | Response shape: array input | REQ-API-002 | Response is array |
| API-D-007 | POST empty object | REQ-API-003a | 200 OK, empty array |
| API-D-008 | POST empty array | REQ-API-003b | 200 OK, empty array |

#### Known Issue (Fixed)

**Issue:** Prior to the MongoDB 5.x migration fix, `devicestatus.create()` had a race condition when processing arrays due to closure variable capture in async loops.

**Fix:** Refactored to use `async.eachSeries()` for sequential processing.

**Verification Test:**
```javascript
it('POST accepts array with multiple elements', function (done) {
  var statuses = [
    { device: 'test1', uploaderBattery: 80 },
    { device: 'test2', uploaderBattery: 90 },
    { device: 'test3', uploaderBattery: 100 }
  ];
  
  request(self.app)
    .post('/api/v1/devicestatus')
    .set('api-secret', self.apiSecret)
    .send(statuses)
    .expect(200)
    .expect(function (res) {
      res.body.length.should.equal(3);
      // Verify all unique devices were stored
      var devices = res.body.map(d => d.device);
      devices.should.containEql('test1');
      devices.should.containEql('test2');
      devices.should.containEql('test3');
    })
    .end(done);
});
```

---

## 4. WebSocket Test Cases

### 4.1 dbAdd Operations

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| WS-001 | dbAdd single treatment | REQ-WS-001a | Document created, callback with array |
| WS-002 | dbAdd array of treatments | REQ-WS-001a | All documents created |
| WS-003 | dbAdd single devicestatus | REQ-WS-001b | Document created, callback with array |
| WS-004 | dbAdd array of devicestatus | REQ-WS-001b | All documents created |
| WS-005 | dbAdd single entry | REQ-WS-001c | Document created, callback with array |
| WS-006 | dbAdd array of entries | REQ-WS-001c | All documents created |
| WS-007 | Callback response shape | REQ-WS-002 | Always returns array |
| WS-008 | Event emission | REQ-WS-003 | data-update and data-received emitted |

#### Known Issue (Fixed)

**Issue:** WebSocket `dbAdd` used `insertOne()` with array input, which creates a single document containing the array as a value, not multiple documents.

**Fix:** Added array detection and sequential processing via `processSingleDbAdd()` helper.

**Verification Test:**
```javascript
it('dbAdd with array input for treatments - current behavior test', function (done) {
  var treatments = [
    { eventType: 'Note', notes: 'ws batch 1' },
    { eventType: 'Note', notes: 'ws batch 2' }
  ];
  
  socket.emit('dbAdd', { 
    collection: 'treatments', 
    data: treatments 
  }, function (result) {
    result.should.be.an.Array();
    result.length.should.equal(2);
    
    // Verify individual documents in database
    self.ctx.treatments().find({}).toArray(function (err, docs) {
      docs.length.should.be.greaterThanOrEqual(2);
      done();
    });
  });
});
```

### 4.2 Other WebSocket Operations

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| WS-009 | dbUpdate single treatment | N/A | Document updated |
| WS-010 | dbRemove single treatment | N/A | Document deleted |

---

## 5. Storage Layer Test Cases

### 5.1 Treatments Storage

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| STG-T-001 | create() with single object | REQ-STORAGE-001a | Document created |
| STG-T-002 | create() with single-element array | REQ-STORAGE-001a | Document created |
| STG-T-003 | create() with multi-element array | REQ-STORAGE-001a | All documents created |
| STG-T-004 | create() with large batch (100+) | REQ-STORAGE-003 | All documents created |

### 5.2 Devicestatus Storage

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| STG-D-001 | create() with single object | REQ-STORAGE-001b | Document created |
| STG-D-002 | create() with single-element array | REQ-STORAGE-001b | Document created |
| STG-D-003 | create() with multi-element array | REQ-STORAGE-001b | All documents created |
| STG-D-004 | create() with large batch (100+) | REQ-STORAGE-003 | All documents created |

### 5.3 Entries Storage

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| STG-E-001 | create() with single entry in array | REQ-STORAGE-001c | Entry created |
| STG-E-002 | create() with multi-entry array | REQ-STORAGE-001c | All entries created |

### 5.4 Other Collections

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| STG-P-001 | profile.create() single object | REQ-STORAGE-001d | Profile created |
| STG-F-001 | food.create() single object | REQ-STORAGE-001e | Food item created |
| STG-A-001 | activity.create() array (single not supported) | REQ-STORAGE-001f | Activity created |

---

## 6. MongoDB Behavior Tests

### 6.1 insertOne vs insertMany Verification

| Test ID | Test Case | Purpose |
|---------|-----------|---------|
| MONGO-001 | insertOne with object | Verify single document creation |
| MONGO-002 | insertOne with array | **Document issue:** Creates 1 doc with array as value |
| MONGO-003 | insertMany with array | Verify multiple document creation |

**Critical Finding:**
```javascript
// WRONG: This creates ONE document with array indices as fields
collection.insertOne([{a:1}, {b:2}])
// Result: { "0": {a:1}, "1": {b:2}, "_id": "..." }

// CORRECT: This creates TWO documents
collection.insertMany([{a:1}, {b:2}])
// Result: [{ "a":1, "_id": "..." }, { "b":2, "_id": "..." }]
```

---

## 7. Edge Case Tests

### 7.1 Empty Input Handling

| Test ID | Input | Expected Result |
|---------|-------|-----------------|
| EDGE-001 | `{}` | Empty array response, no database write |
| EDGE-002 | `[]` | Empty array response, no database write |
| EDGE-003 | `null` | Error response or empty array |
| EDGE-004 | `undefined` | Error response or empty array |

### 7.2 Mixed Event Types

| Test ID | Test Case | Expected Result |
|---------|-----------|-----------------|
| EDGE-005 | Array with different eventTypes | All documents created with correct types |

```javascript
it('treatments array with different eventTypes', function (done) {
  var mixed = [
    { eventType: 'Correction Bolus', insulin: 2 },
    { eventType: 'Carb Correction', carbs: 15 },
    { eventType: 'Note', notes: 'mixed test' }
  ];
  
  request(self.app)
    .post('/api/v1/treatments')
    .send(mixed)
    .expect(200)
    .expect(function (res) {
      res.body.length.should.equal(3);
      var types = res.body.map(t => t.eventType);
      types.should.containEql('Correction Bolus');
      types.should.containEql('Carb Correction');
      types.should.containEql('Note');
    })
    .end(done);
});
```

---

## 8. Test Environment Setup

### 8.1 Prerequisites

```javascript
before(function (done) {
  process.env.API_SECRET = 'this is my long pass phrase';
  self.env = require('../lib/server/env')();
  self.env.settings.enable = ['careportal', 'api'];
  
  require('../lib/server/bootevent')(self.env, language)
    .boot(function booted(ctx) {
      self.ctx = ctx;
      self.app = require('../lib/server/app')(self.env, ctx);
      done();
    });
});
```

### 8.2 Cleanup

```javascript
beforeEach(function (done) {
  self.ctx.treatments().deleteMany({}, done);
});

afterEach(function (done) {
  self.ctx.treatments().deleteMany({}, done);
});
```

---

## 9. Coverage Matrix

| Requirement | Test ID(s) | Status |
|-------------|------------|--------|
| REQ-API-001a | API-T-001 to API-T-004 | Covered |
| REQ-API-001c | API-D-001 to API-D-004 | Covered |
| REQ-API-002 | API-T-005, API-T-006, API-D-005, API-D-006 | Covered |
| REQ-API-003 | API-T-007, API-T-008, API-D-007, API-D-008 | Covered |
| REQ-API-004 | API-T-004, API-D-004 | Covered |
| REQ-WS-001 | WS-001 to WS-006 | Covered |
| REQ-WS-002 | WS-007 | Covered |
| REQ-WS-003 | WS-008 | Covered |
| REQ-WS-004 | MONGO-002 (documents issue) | Covered |
| REQ-STORAGE-001 | STG-T-*, STG-D-*, STG-E-* | Covered |
| REQ-STORAGE-003 | STG-T-004, STG-D-004 | Covered |

---

## 10. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Nightscout Team | Initial specification |

---

## 11. References

- [Data Shape Requirements](../requirements/data-shape-requirements.md)
- [API v1 Compatibility Spec](../requirements/api-v1-compatibility-spec.md)
- [API Layer Audit](../api-layer-audit.md)
- Test files in `tests/` directory
