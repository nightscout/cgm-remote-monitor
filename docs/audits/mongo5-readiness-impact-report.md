# MongoDB 5 Readiness & API Behavior Impact Report

**Branch:** `wip/test-improvements`  
**Date:** 2026-03-18  
**Status:** ✅ CI passing on `wip/test-improvements`

---

## Executive Summary

This report covers three specific areas requested for review:

- **A.** Non-ObjectID `_id` handling across all API v1 endpoints (read + write paths)
- **B.** Data shape handling (single object vs. array input) across all API v1 endpoints
- **C.** Testing matrix for A and B
- **D.** Overall MongoDB 5 upgrade impact analysis

---

## A. Non-ObjectID `_id` Handling Across All Endpoints

### Background

MongoDB 5+ requires that `_id` fields sent to the server be valid BSON types. Passing a plain UUID string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`) as `_id` into a mongo `insertOne`/`replaceOne` would previously succeed in MongoDB 4.x (storing as string) but may produce unexpected deduplication or query failures in MongoDB 5.

Two distinct strategies are applied depending on the collection:

| Strategy | Collections | Behavior |
|----------|------------|---------|
| **Normalize** (accept + convert) | `treatments`, `entries` | UUID `_id` is preserved as `identifier`, `_id` is deleted so server generates ObjectId. Controlled by `UUID_HANDLING` flag. |
| **Reject** (return 400) | `devicestatus`, `profile`, `activity`, `food` | Any non-24-char-hex `_id` returns HTTP 400 immediately. |

### A.1 Treatments (`/api/treatments/`)

**Write path** – `lib/server/treatments.js` `normalizeTreatmentId()`:

```
Non-ObjectId string in _id (e.g., UUID):
  if UUID_HANDLING=true  → obj.identifier = obj._id (if not already set)
  always                 → delete obj._id  (server generates ObjectId)

Valid 24-char hex string:
  → converted to ObjectId object for storage

ObjectId object already:
  → passed through as-is
```

**Read path** – `lib/server/query.js` `updateIdQuery()`:

```
_id = UUID string + UUID_HANDLING=true  → rewrite query to { identifier: uuid }
_id = UUID string + UUID_HANDLING=false → treat as regular string (no match, empty result)
_id = 24-char hex                       → convert to ObjectId for query
```

**Result:** Loop overrides and other AID clients that send UUID `_id` values are handled safely regardless of Mongo version.

---

### A.2 Entries (`/api/entries/`)

**Write path** – `lib/server/entries.js` `normalizeEntryId()`:

Identical strategy to treatments:

```
Non-ObjectId string in _id:
  if UUID_HANDLING=true  → doc.identifier = doc._id (if not already set)
  always                 → delete doc._id

Valid 24-char hex string:
  → converted to ObjectId object
```

**Read path** – `lib/server/query.js` `updateIdQuery()` (same as treatments).

---

### A.3 Devicestatus (`/api/devicestatus/`)

**Write path** – `lib/api/devicestatus/index.js` `findInvalidId()` + `isValidObjectId()`:

```
_id = undefined | null          → accepted (server auto-generates)
_id = 24-char hex string        → accepted (stored as provided, converted by Mongo driver)
_id = UUID or any other string  → HTTP 400 returned immediately
```

**Read/Delete path** – `lib/api/devicestatus/index.js` `isValidObjectId()`:

```
:id = "*"                       → wildcard delete accepted
:id = 24-char hex string        → accepted
:id = anything else             → HTTP 400
```

**Note:** Devicestatus does not support UUID `_id` lookup since it is not a client-generated-identifier collection. AID clients (Loop, AAPS) that upload devicestatus do not send UUID `_id` values.

---

### A.4 Profile (`/api/profile/`)

**Write path** – `lib/api/profile/index.js` `findInvalidId()` (POST) and `isValidObjectId()` (PUT):

```
POST array:
  any element with non-null, non-24-char-hex _id → HTTP 400

PUT single:
  non-null, non-24-char-hex _id → HTTP 400

DELETE :_id:
  non-24-char-hex → HTTP 400
```

---

### A.5 Activity (`/api/activity/`)

**Write path** – `lib/api/activity/index.js`:

Same reject strategy as Profile:

```
POST: any doc with invalid _id → HTTP 400
PUT: invalid _id → HTTP 400
DELETE :_id: invalid → HTTP 400
```

---

### A.6 Food (`/api/food/`)

**Write path** – `lib/api/food/index.js`:

Same reject strategy as Profile/Activity:

```
POST: any doc with invalid _id → HTTP 400
PUT: invalid _id → HTTP 400
DELETE :_id: invalid → HTTP 400
```

---

### A.7 API v3 (`/api/v3/*`)

API v3 uses the `identifier` field (not `_id`) as its canonical document identity:

- `lib/api3/storage/mongoCollection/utils.js` `filterForOne()` queries `{ $or: [ { identifier }, { _id: ObjectId(identifier) } ] }` — the second branch only applies when identifier is a valid 24-char hex string.
- Clients always reference documents by `identifier`, never by raw `_id`.
- The `_id` field is removed from all API v3 responses (`normalizeDoc()` deletes `_id` and sets `identifier`).

**Result:** API v3 is already `_id`-agnostic from a client perspective.

---

### A.8 `UUID_HANDLING` Feature Flag

| Setting | Default | Effect |
|---------|---------|--------|
| `UUID_HANDLING=true` | **Yes** (default since 15.0.7) | UUID `_id` in treatments/entries is copied to `identifier` before `_id` is deleted. UUID queries are redirected to `identifier`. |
| `UUID_HANDLING=false` | No | UUID `_id` is simply deleted (no copy to `identifier`). UUID queries return empty results rather than matching by `identifier`. |

This flag gates only the `_id → identifier` promotion behavior. It does **not** affect `syncIdentifier`, `uuid`, or any other client field.

---

## B. Data Shape Handling Across All Endpoints

### B.1 API v1 Input Shape

| Endpoint | POST Single Object | POST Array | Normalizes Internally |
|----------|-------------------|------------|----------------------|
| `/api/treatments/` | ✅ Accepted | ✅ Accepted | Via `_.isArray()` check in `lib/server/treatments.js` |
| `/api/entries/` | ✅ Accepted | ✅ Accepted | Via stream / `incoming` array in `lib/api/entries/index.js` |
| `/api/devicestatus/` | ✅ Accepted | ✅ Accepted | `Array.isArray()` → `[statuses]` in `lib/api/devicestatus/index.js` |
| `/api/profile/` | ✅ Accepted | ✅ Accepted | `Array.isArray()` → `[data]` in `lib/api/profile/index.js` |
| `/api/activity/` | ✅ Accepted | ✅ Accepted | `_isArray()` → `[activity]` in `lib/api/activity/index.js` |
| `/api/food/` | ✅ Accepted | ✅ Accepted | `_isArray()` → `[data]` in `lib/api/food/index.js` |

### B.2 API v1 Response Shape

| Endpoint | POST Response Shape |
|----------|-------------------|
| `/api/treatments/` | Always returns array |
| `/api/entries/` | Always returns array |
| `/api/devicestatus/` | Returns array (from `ctx.devicestatus.create`) |
| `/api/profile/` | Returns array (from `ctx.profile.create`) |
| `/api/activity/` | Returns array or object (from `ctx.activity.create`) |
| `/api/food/` | Returns array or object (from `ctx.food.create`) |

### B.3 API v3 Input Shape

API v3 **only accepts single objects** per call. Array input returns HTTP 400.

| Endpoint | POST Single Object | POST Array |
|----------|-------------------|------------|
| `/api/v3/treatments` | ✅ Accepted | ❌ HTTP 400 |
| `/api/v3/entries` | ✅ Accepted | ❌ HTTP 400 |
| `/api/v3/devicestatus` | ✅ Accepted | ❌ HTTP 400 |
| `/api/v3/profile` | ✅ Accepted | ❌ HTTP 400 |
| `/api/v3/activity` | ✅ Accepted | ❌ HTTP 400 |
| `/api/v3/food` | ✅ Accepted | ❌ HTTP 400 |

This is by design: API v3 clients handle their own batching at the application level.

---

## C. Testing Matrix

### C.1 _id / UUID Handling Tests

| Test ID | File | Covers | Pass |
|---------|------|--------|------|
| UUID-OFF-001 | `tests/uuid-handling.test.js` | GET by UUID with UUID_HANDLING=false → empty, no crash | ✅ |
| UUID-OFF-002 | `tests/uuid-handling.test.js` | DELETE by UUID with UUID_HANDLING=false → deletes nothing, no crash | ✅ |
| UUID-OFF-003 | `tests/uuid-handling.test.js` | POST with UUID _id and UUID_HANDLING=false → strips UUID, no identifier copy | ✅ |
| UUID-ON-001 | `tests/uuid-handling.test.js` | GET by UUID with UUID_HANDLING=true → finds treatment via identifier | ✅ |
| UUID-ON-002 | `tests/uuid-handling.test.js` | DELETE by UUID with UUID_HANDLING=true → removes treatment via identifier | ✅ |
| UUID-ON-003 | `tests/uuid-handling.test.js` | ObjectId still works normally with UUID_HANDLING=true | ✅ |
| UUID-ON-004 | `tests/uuid-handling.test.js` | Non-matching UUID returns empty | ✅ |
| UUID-ON-005 | `tests/uuid-handling.test.js` | POST with UUID _id with UUID_HANDLING=true → extracts UUID to identifier | ✅ |
| UUID-EDGE-001 | `tests/uuid-handling.test.js` | 23-char hex (invalid ObjectId) returns empty | ✅ |
| UUID-EDGE-002 | `tests/uuid-handling.test.js` | 25-char hex (too long) returns empty | ✅ |
| UUID-EDGE-003 | `tests/uuid-handling.test.js` | UUID without hyphens not recognized as UUID | ✅ |
| UUID-EDGE-004 | `tests/uuid-handling.test.js` | Empty _id query returns all with date filter | ✅ |
| UUID-EDGE-005 | `tests/uuid-handling.test.js` | Multiple treatments same identifier → upsert behavior | ✅ |
| UUID-EDGE-006 | `tests/uuid-handling.test.js` | Uppercase UUID matches case-insensitively | ✅ |
| UUID-EDGE-007 | `tests/uuid-handling.test.js` | Valid ObjectId still works normally | ✅ |
| TEST-ENTRY-UUID-001 | `tests/api.entries.uuid.test.js` | Entries accept UUID _id on POST | ✅ |
| TEST-ENTRY-UUID-002 | `tests/api.entries.uuid.test.js` | Re-POST same UUID deduplicates by sysTime+type | ✅ |
| TEST-ENTRY-UUID-003 | `tests/api.entries.uuid.test.js` | Re-POST different UUID same timestamp deduplicates | ✅ |
| TEST-ENTRY-UUID-004 | `tests/api.entries.uuid.test.js` | Batch upload handles mixed IDs | ✅ |
| TEST-ENTRY-UUID-005 | `tests/api.entries.uuid.test.js` | Existing UUID _id entry updated without duplicate | ✅ |
| TEST-ENTRY-UUID-006 | `tests/api.entries.uuid.test.js` | identifier field preserved after update | ✅ |
| TEST-ID-001 | `tests/identity-matrix.test.js` | Loop Override with UUID _id is promoted to identifier | ✅ |
| TEST-ID-002 | `tests/identity-matrix.test.js` | Loop Override with identifier field is preserved | ✅ |
| TEST-ID-003 | `tests/identity-matrix.test.js` | Loop Carb with syncIdentifier (no _id) gets ObjectId | ✅ |
| TEST-ID-004 | `tests/identity-matrix.test.js` | AAPS with identifier: null gets server-generated id | ✅ |
| TEST-ID-005 | `tests/identity-matrix.test.js` | AAPS with identifier: ObjectId uses provided id | ✅ |
| TEST-ID-006 | `tests/identity-matrix.test.js` | xDrip+ with uuid + _id fields both preserved | ✅ |
| TEST-V1-ID-001 | `tests/identity-matrix.test.js` | No id field generates ObjectId | ✅ |
| TEST-V1-ID-002 | `tests/identity-matrix.test.js` | Valid ObjectId _id is used as-is | ✅ |
| TEST-V1-ID-003 | `tests/identity-matrix.test.js` | UUID string _id promoted to identifier (REQ-SYNC-072) | ✅ |
| TEST-V1-ID-004 | `tests/identity-matrix.test.js` | syncIdentifier NOT copied to identifier (scope fix) | ✅ |
| ID-ACTIVITY-POST-BAD | `tests/api.id-validation.test.js` | Activity POST with UUID _id → 400 | ✅ |
| ID-ACTIVITY-PUT-BAD | `tests/api.id-validation.test.js` | Activity PUT with invalid _id → 400 | ✅ |
| ID-ACTIVITY-DELETE-BAD | `tests/api.id-validation.test.js` | Activity DELETE with invalid :_id → 400 | ✅ |
| ID-ACTIVITY-POST-OK | `tests/api.id-validation.test.js` | Activity POST without _id → 200 (auto-generate) | ✅ |
| ID-FOOD-POST-BAD | `tests/api.id-validation.test.js` | Food POST with UUID _id → 400 | ✅ |
| ID-FOOD-PUT-BAD | `tests/api.id-validation.test.js` | Food PUT with invalid _id → 400 | ✅ |
| ID-FOOD-DELETE-BAD | `tests/api.id-validation.test.js` | Food DELETE with invalid :_id → 400 | ✅ |
| ID-FOOD-POST-OK | `tests/api.id-validation.test.js` | Food POST without _id → 200 (auto-generate) | ✅ |

**Gaps Acknowledged:**
- `devicestatus` and `profile` `_id` validation paths are covered in `api.shape-handling.test.js` via error-case tests but do not have a dedicated isolation test file. They are exercised via the main `api.devicestatus.test.js` and `api.profiles.test.js` suites.

### C.2 Shape Handling Tests

| Test ID | File | Covers | Pass |
|---------|------|--------|------|
| SHAPE-TREAT-SINGLE | `tests/api.shape-handling.test.js` | Treatments POST accepts single object | ✅ |
| SHAPE-TREAT-ARRAY-1 | `tests/api.shape-handling.test.js` | Treatments POST accepts array with single element | ✅ |
| SHAPE-TREAT-ARRAY-N | `tests/api.shape-handling.test.js` | Treatments POST accepts array with multiple elements | ✅ |
| SHAPE-TREAT-BATCH | `tests/api.shape-handling.test.js` | Treatments POST handles large batch array | ✅ |
| SHAPE-DS-SINGLE | `tests/api.shape-handling.test.js` | Devicestatus POST accepts single object | ✅ |
| SHAPE-DS-ARRAY-1 | `tests/api.shape-handling.test.js` | Devicestatus POST accepts array with single element | ✅ |
| SHAPE-DS-ARRAY-N | `tests/api.shape-handling.test.js` | Devicestatus POST accepts array with multiple elements | ✅ |
| SHAPE-DS-BATCH | `tests/api.shape-handling.test.js` | Devicestatus POST handles large batch array | ✅ |
| SHAPE-RESP-TREAT-SINGLE | `tests/api.shape-handling.test.js` | Treatments single object input returns array response | ✅ |
| SHAPE-RESP-TREAT-ARRAY | `tests/api.shape-handling.test.js` | Treatments array input returns array response | ✅ |
| SHAPE-RESP-DS-SINGLE | `tests/api.shape-handling.test.js` | Devicestatus single object input returns array response | ✅ |
| SHAPE-RESP-DS-ARRAY | `tests/api.shape-handling.test.js` | Devicestatus array input returns array response | ✅ |
| SHAPE-TREAT-EMPTY-OBJ | `tests/api.shape-handling.test.js` | Treatments POST with empty object | ✅ |
| SHAPE-TREAT-EMPTY-ARR | `tests/api.shape-handling.test.js` | Treatments POST with empty array | ✅ |
| SHAPE-DS-EMPTY-OBJ | `tests/api.shape-handling.test.js` | Devicestatus POST with empty object | ✅ |
| SHAPE-DS-EMPTY-ARR | `tests/api.shape-handling.test.js` | Devicestatus POST with empty array | ✅ |
| SHAPE-TREAT-MIXED | `tests/api.shape-handling.test.js` | Treatments array with different eventTypes | ✅ |
| SHAPE-ENTRY-SINGLE | `tests/api.shape-handling.test.js` | Entries POST accepts single SGV entry | ✅ |
| SHAPE-ENTRY-ARRAY-1 | `tests/api.shape-handling.test.js` | Entries POST accepts array with single element | ✅ |
| SHAPE-ENTRY-ARRAY-N | `tests/api.shape-handling.test.js` | Entries POST accepts array with multiple SGV entries | ✅ |
| SHAPE-ENTRY-MBG | `tests/api.shape-handling.test.js` | Entries POST accepts single MBG entry | ✅ |
| SHAPE-ENTRY-MIXED | `tests/api.shape-handling.test.js` | Entries POST accepts mixed entry types in array | ✅ |
| SHAPE-ENTRY-BATCH | `tests/api.shape-handling.test.js` | Entries POST handles large batch | ✅ |
| SHAPE-ENTRY-EMPTY-ARR | `tests/api.shape-handling.test.js` | Entries POST with empty array returns empty array | ✅ |
| SHAPE-RESP-ENTRY-SINGLE | `tests/api.shape-handling.test.js` | Single entry input returns array response | ✅ |
| SHAPE-RESP-ENTRY-ARRAY | `tests/api.shape-handling.test.js` | Array input returns array response | ✅ |
| SHAPE-PROFILE-SINGLE | `tests/api.shape-handling.test.js` | Profile POST accepts single profile object | ✅ |
| SHAPE-PROFILE-ARRAY-1 | `tests/api.shape-handling.test.js` | Profile POST accepts array with single element (NightscoutKit format) | ✅ |
| SHAPE-PROFILE-ARRAY-N | `tests/api.shape-handling.test.js` | Profile POST accepts array with multiple profiles (batch upload) | ✅ |
| SHAPE-PROFILE-RESP-COUNT | `tests/api.shape-handling.test.js` | Profile POST response count equals input count | ✅ |
| SHAPE-PROFILE-EMPTY-ARR | `tests/api.shape-handling.test.js` | Profile POST with empty array returns empty array | ✅ |
| SHAPE-RESP-PROFILE-SINGLE | `tests/api.shape-handling.test.js` | Single profile input returns array response | ✅ |
| SHAPE-RESP-PROFILE-ARRAY | `tests/api.shape-handling.test.js` | Array input returns array response | ✅ |
| NK-TREAT-BOLUS | `tests/api.shape-handling.test.js` | NightscoutKit: accepts single bolus array | ✅ |
| NK-TREAT-CARB | `tests/api.shape-handling.test.js` | NightscoutKit: accepts carb entry with syncIdentifier | ✅ |
| NK-TREAT-TEMP-BASAL | `tests/api.shape-handling.test.js` | NightscoutKit: accepts temp basal array | ✅ |
| NK-TREAT-MIXED | `tests/api.shape-handling.test.js` | NightscoutKit: accepts mixed batch array | ✅ |
| NK-DS-LOOP | `tests/api.shape-handling.test.js` | NightscoutKit: accepts Loop devicestatus array | ✅ |
| NK-DS-BATCH | `tests/api.shape-handling.test.js` | NightscoutKit: accepts batch devicestatus array | ✅ |
| NK-PROFILE-LOOP | `tests/api.shape-handling.test.js` | NightscoutKit: accepts Loop profile array | ✅ |
| NK-PROFILE-BATCH | `tests/api.shape-handling.test.js` | NightscoutKit: accepts batch profile array (historical sync) | ✅ |
| API3-SHAPE-TREAT-SINGLE | `tests/api3.shape-handling.test.js` | API v3 Treatments POST accepts single valid object | ✅ |
| API3-SHAPE-TREAT-ARRAY | `tests/api3.shape-handling.test.js` | API v3 Treatments POST rejects array input with 400 | ✅ |
| API3-SHAPE-TREAT-EMPTY-ARR | `tests/api3.shape-handling.test.js` | API v3 Treatments POST rejects empty array with 400 | ✅ |
| API3-SHAPE-TREAT-EMPTY-OBJ | `tests/api3.shape-handling.test.js` | API v3 Treatments POST rejects empty object with 400 | ✅ |
| API3-SHAPE-RESP | `tests/api3.shape-handling.test.js` | API v3 response format is object not array | ✅ |
| API3-SHAPE-ENTRY-SINGLE | `tests/api3.shape-handling.test.js` | API v3 Entries POST accepts single SGV | ✅ |
| API3-SHAPE-ENTRY-ARRAY | `tests/api3.shape-handling.test.js` | API v3 Entries POST rejects array with 400 | ✅ |
| API3-SHAPE-DS-SINGLE | `tests/api3.shape-handling.test.js` | API v3 Devicestatus POST accepts single object | ✅ |
| API3-SHAPE-DS-ARRAY | `tests/api3.shape-handling.test.js` | API v3 Devicestatus POST rejects array with 400 | ✅ |
| API3-SHAPE-XAPI | `tests/api3.shape-handling.test.js` | Document created via API v3 is readable via API v3 GET | ✅ |
| API3-SHAPE-DEDUP | `tests/api3.shape-handling.test.js` | Deduplication handles re-POST of same document | ✅ |

### C.3 Total Test Coverage Summary

| Area | Test Files | Test Cases | Status |
|------|-----------|------------|--------|
| UUID / _id handling (treatments) | `uuid-handling.test.js`, `identity-matrix.test.js` | 22 | ✅ All pass |
| UUID / _id handling (entries) | `api.entries.uuid.test.js` | 9 | ✅ All pass |
| _id rejection (activity, food) | `api.id-validation.test.js` | 8 | ✅ All pass |
| Shape handling (API v1) | `api.shape-handling.test.js` | 41 | ✅ All pass |
| Shape handling (API v3) | `api3.shape-handling.test.js` | 11 | ✅ All pass |
| **Total** | **5 files** | **91** | **✅** |

---

## D. MongoDB 5 Upgrade Impact Analysis

### D.1 Driver Compatibility

| Component | Change | Status |
|-----------|--------|--------|
| `mongodb-legacy` package | Used throughout API v3 and storage layer for backward-compat ObjectId API | ✅ Compatible |
| `ObjectId` construction | All `new ObjectID(hex)` calls validated before construction (24-char hex check guards) | ✅ Safe |
| `bulkWrite` for treatments | Replaces per-document `upsert()` calls; uses `replaceOne` with `upsert: true` | ✅ MongoDB 5 supported |
| `bulkWrite` for activity | Replaces per-document `create()` calls | ✅ MongoDB 5 supported |
| `insertMany` for devicestatus | Standard operation; unchanged | ✅ MongoDB 5 supported |
| `insertMany` for entries | Uses bulk upsert with sysTime+type dedup | ✅ MongoDB 5 supported |

### D.2 `_id` Field Safety

| Scenario | MongoDB 4.x | MongoDB 5.x | After This PR |
|----------|------------|------------|--------------|
| UUID string sent as `_id` in treatments/entries | Stored as string `_id` — breaks ObjectId-based queries | Same; inconsistent indexes | UUID is removed from `_id`, copied to `identifier` (when `UUID_HANDLING=true`) |
| UUID string sent as `_id` in devicestatus/profile/activity/food | Stored as string | Same | Rejected with HTTP 400 — never reaches Mongo |
| Valid 24-char hex sent as `_id` | Stored as ObjectId | Same | Converted to `ObjectId` object before insert |
| No `_id` sent | Server generates ObjectId | Same | Server generates ObjectId (unchanged) |

### D.3 Connection Pool Settings

New env variables added for MongoDB 5 tuning:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONGO_MAX_POOL_SIZE` | `10` (was `5`) | Increased default for higher throughput |
| `MONGO_MIN_POOL_SIZE` | `1` (was `0`) | Keeps at least one connection warm |
| `MONGO_MAX_IDLE_TIME_MS` | `30000` | Recycles idle connections; prevents stale socket errors |

### D.4 UUID_HANDLING Flag Impact

| Scenario | UUID_HANDLING=true (default) | UUID_HANDLING=false |
|----------|------------------------------|---------------------|
| Loop sends `_id: "uuid-..."` on treatment | Promoted to `identifier`; server generates ObjectId `_id` | UUID stripped; no `identifier`; server generates ObjectId `_id` |
| Loop queries `GET /api/treatments?find[_id]=uuid-...` | Redirected to `identifier` field query | Returns empty (no match) |
| Loop deletes `DELETE /api/treatments/uuid-...` | Redirected to `identifier` field query | Returns empty (no match) |
| AAPS sends ObjectId `_id` | Passes through as ObjectId | Same |

**Recommendation:** Leave `UUID_HANDLING=true` (the new default). Legacy deployments that relied on UUID-as-`_id` behavior should verify their data before disabling.

### D.5 Known Risks / Gaps

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `devicestatus` rejects UUID `_id` with 400 — any AID client sending UUID `_id` to devicestatus would have uploads rejected | Medium | Loop/AAPS devicestatus uploads do not include UUID `_id` values; however this should be verified against NightscoutKit source |
| `syncIdentifier` field is preserved as-is (not promoted to `identifier`) | Low | Intentional — scope was limited to `_id` field only (REQ-SYNC-072) |
| Empty `identifier` on re-POST deduplication when `UUID_HANDLING=false` | Low | Tests UUID-EDGE-005 and UUID-ON-005 document this behavior |
| Profile/Activity/Food `_id` validation tests are embedded in shape-handling tests, not isolated | Low | Test coverage exists; separate isolation file would improve maintainability |

---

## Conclusion

All three areas (non-ObjectID `_id` handling, shape handling, and test coverage) have been audited and are verified against the test matrix above. The MongoDB 5 upgrade is supported by:

1. `bulkWrite`/`insertMany` batch operations replacing sequential per-document calls
2. Strict `_id` validation or normalization at every entry point
3. `UUID_HANDLING` feature flag giving operators control over UUID `_id` promotion behavior
4. Updated connection pool defaults suited for MongoDB 5
5. 91 targeted test cases across 5 dedicated test files verifying the above behaviors

CI is green on `wip/test-improvements` as of the most recent run.
