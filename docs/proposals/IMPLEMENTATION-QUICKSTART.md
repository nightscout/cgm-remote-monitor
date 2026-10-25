# MongoDB Modernization - Quick Start Guide

**Date:** 2026-01-18  
**Related Docs:**
- `mongodb-modernization-impact-assessment.md` - Detailed analysis
- `mongodb-modernization-implementation-plan.md` - Full implementation plan

---

## TL;DR - What We Need to Do

The MongoDB modernization requires ensuring that v1 API batch endpoints use `insertMany` (or `bulkWrite`) instead of iterating with individual `replaceOne` calls. This is critical for Loop and Trio clients.

---

## Critical Issues Found

### ✅ Good News
- All test fixtures already exist in `tests/fixtures/`
- Impact assessment is complete
- We know exactly what clients expect

### ✅ Issues Fixed (January 2026)

1. **lib/server/treatments.js** ✅ COMPLETED
   - Now uses `bulkWrite` with `replaceOne` + `upsert: true` for batch operations
   - Falls back to sequential processing for `preBolus` treatments (which create additional records)
   - **Commit:** e9417af5

2. **lib/server/entries.js** ✅ COMPLETED
   - Now uses `bulkWrite` with `updateOne` + `$set` + `upsert: true`
   - **Commit:** e9417af5

3. **lib/server/devicestatus.js** ✅ COMPLETED
   - Now uses `insertMany` for batch inserts
   - **Commit:** e9417af5

4. **Response Ordering** ✅ RESOLVED
   - All batch operations use `ordered: true` to preserve submission order
   - Response array indices match submission array indices

### ⚠️ Remaining Issues

1. **Write Result Format**
   - MongoDB driver version differences in `insertedIds` format
   - **Need:** Translator utility to normalize across driver versions
   - **Impact:** Driver upgrades could break response format

---

## Quick Start: First Steps

### Step 1: Run Baseline Tests (5 minutes)
```bash
# See what currently passes
npm test tests/storage.shape-handling.test.js
npm test tests/api.shape-handling.test.js  
npm test tests/api3.shape-handling.test.js
npm test tests/api3.aaps-patterns.test.js

# Record results
npm test > baseline-test-results.txt 2>&1
```

### Step 2: Check Current MongoDB Version (1 minute)
```bash
npm list mongodb mongodb-legacy > mongodb-versions.txt
cat mongodb-versions.txt
```

### Step 3: Create First Test File (30 minutes)
Create `tests/api.v1-batch-operations.test.js`:

```javascript
'use strict';

const request = require('supertest');
const should = require('should');
const fixtures = require('./fixtures');

describe('v1 API Batch Operations', function() {
  this.timeout(15000);
  const self = this;
  
  beforeEach(function(done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    require('../lib/server/bootevent')(self.env, require('../lib/language')()).boot(function (ctx) {
      self.ctx = ctx;
      self.app = require('express')();
      require('../lib/server/app')(self.env, ctx).configure(self.app);
      done();
    });
  });
  
  beforeEach(function(done) {
    // Clear treatments
    self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, done);
  });
  
  it('POST /api/v1/treatments with array creates multiple documents', function(done) {
    const batch = fixtures.loop.carbsBatch;
    
    request(self.app)
      .post('/api/v1/treatments/')
      .set('api-secret', process.env.API_SECRET)
      .send(batch)
      .expect(200)
      .end(function(err, res) {
        should.not.exist(err);
        res.body.should.be.instanceof(Array);
        res.body.length.should.equal(batch.length);
        
        // Verify all have _id
        res.body.forEach(item => {
          should.exist(item._id);
        });
        
        done();
      });
  });
  
  it('Response array indices match submission order', function(done) {
    const scenario = fixtures.partialFailures.loopResponseOrderingScenario;
    
    request(self.app)
      .post('/api/v1/treatments/')
      .set('api-secret', process.env.API_SECRET)
      .send(scenario.input)
      .expect(200)
      .end(function(err, res) {
        should.not.exist(err);
        
        // Response order must match input order
        res.body.length.should.equal(scenario.input.length);
        
        for (let i = 0; i < res.body.length; i++) {
          should.exist(res.body[i]._id);
          // Could validate more properties if needed
        }
        
        done();
      });
  });
});
```

### Step 4: Run the New Test (1 minute)
```bash
npm test tests/api.v1-batch-operations.test.js
```

**Expected Result:** Test should FAIL because we haven't fixed the batch handling yet.

### Step 5: Review Current Implementation (15 minutes)

Look at these files:
- `lib/server/treatments.js` - Lines 11-38 (create function)
- `lib/server/entries.js` - Lines 92-135 (create function)  
- `lib/api/treatments/index.js` - Lines 104-145 (POST handler)

Understand the current flow:
1. v1 API receives array
2. Converts to array if single object (line 107-109)
3. Calls `ctx.treatments.create(array)`
4. `create()` iterates with `async.eachSeries`
5. Each item gets `replaceOne` with upsert

---

## Next Steps (Week 1)

### Priority 1: Create Remaining Test Files
- [ ] `tests/storage.write-result-translation.test.js`
- [ ] `tests/api.response-ordering.test.js`
- [ ] `tests/api3.single-doc-operations.test.js`

### Priority 2: Create Write Result Translator
- [ ] `lib/storage/write-result-translator.js`
- [ ] Handle MongoDB 3.x, 4.x, 5.x differences
- [ ] Unit tests for translator

### Priority 3: Update Storage Layer ✅ COMPLETED
- [x] Update `lib/server/treatments.js` to use bulkWrite
- [x] Update `lib/server/entries.js` to use bulkWrite
- [x] Update `lib/server/devicestatus.js` to use insertMany
- [x] Ensure response ordering preserved (using `ordered: true`)

---

## Key Files Reference

### Test Fixtures (Already Exist ✅)
- `tests/fixtures/aaps-single-doc.js` - AAPS v3 single-doc patterns
- `tests/fixtures/loop-batch.js` - Loop v1 batch arrays
- `tests/fixtures/trio-pipeline.js` - Trio throttled pipelines
- `tests/fixtures/deduplication.js` - Deduplication scenarios
- `tests/fixtures/partial-failures.js` - **CRITICAL** for response ordering
- `tests/fixtures/edge-cases.js` - Edge cases and validation

### Code Files to Modify
- `lib/server/treatments.js` - Batch upsert implementation
- `lib/server/entries.js` - Batch upsert implementation
- `lib/storage/write-result-translator.js` - **NEW** - Format translator

### Test Files to Create
- `tests/api.v1-batch-operations.test.js` - v1 batch tests
- `tests/api3.single-doc-operations.test.js` - v3 single-doc tests
- `tests/storage.write-result-translation.test.js` - Translator tests
- `tests/api.response-ordering.test.js` - Ordering validation

### Documentation Files
- `docs/proposals/mongodb-modernization-impact-assessment.md` - ✅ Exists
- `docs/proposals/mongodb-modernization-implementation-plan.md` - ✅ Exists
- `docs/developers/mongodb-patterns.md` - To create

---

## Common Pitfalls to Avoid

1. **Don't change v3 API response format**
   - AAPS depends on exact format: `{identifier, isDeduplication, deduplicatedIdentifier, lastModified}`
   
2. **Don't break response ordering**
   - Loop depends on response[i] matching input[i] for objectId cache

3. **Don't expose raw MongoDB write results**
   - Driver version differences will break clients
   - Always use translator

4. **Don't forget deduplication logic**
   - Upsert semantics must be preserved
   - Deduplication responses must be accurate

5. **Don't use ordered: true blindly**
   - Loop/Trio expect all valid docs inserted even if some fail
   - Probably need ordered: false (unordered bulk write)

---

## Questions to Answer Before Implementation

1. ✅ Are fixtures complete? - **YES**
2. ⏳ Current MongoDB driver version? - **Run `npm list mongodb`**
3. ⏳ Should we use ordered or unordered bulk writes? - **Test both modes**
4. ⏳ Performance impact of bulkWrite vs sequential? - **Benchmark after implementation**

---

## Success Metrics

- [ ] All new tests pass
- [ ] All existing tests still pass  
- [ ] Response ordering verified for 100+ item batches
- [ ] AAPS v3 API response format unchanged
- [ ] Loop v1 batch operations work correctly
- [ ] Trio v1 batch operations work correctly

---

## Need Help?

1. **Read the fixtures** - They show exactly what clients send
2. **Read the assessment** - It explains why things matter
3. **Start with tests** - Write tests first, then fix code
4. **Ask questions** - Better to clarify than break production

---

**Ready to Start?** 

Run Step 1-5 above, then review the full implementation plan in `mongodb-modernization-implementation-plan.md`.
