# Proposal: API Query Normalization & Protection

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Priority:** HIGH  
**Authors:** Nightscout Community  
**Related:** [API Layer Audit](../audits/api-layer-audit.md), [Security Audit](../audits/security-audit.md)

---

## 1. Executive Summary

This proposal addresses critical query handling issues across Nightscout's REST APIs (v1, v2, v3). The core problems are:

1. **Type coercion bugs** - Query params arrive as strings with inconsistent parsing
2. **No input validation** - Malicious or malformed queries reach the database
3. **Self-inflicted DDoS** - Clients can request unbounded data or expensive queries
4. **MongoDB injection** - `req.query.find` passes directly to MongoDB in v1/v2
5. **No pagination metadata** - Responses lack total count, next/prev links
6. **Mixed date formats** - Inconsistent date handling across endpoints

### Approach

- **v1/v2:** Shared normalization middleware for legacy query patterns
- **v3:** Schema validation on already-structured params with same limits
- **Rollout:** Warn mode first, then enforce mode

---

## 2. Problem Statement

### 2.1 Evidence from Codebase

**Inconsistent type parsing:**
```javascript
// profile/index.js - Number() without validation
const limit = req.query && req.query.count ? Number(req.query.count) : consts.PROFILES_DEFAULT_COUNT;

// api3/collection.js - parseInt without default handling
limit = parseInt(req.query.limit);

// pebble.js - parseInt with fallback
req.count = parseInt(req.query.count) || 1;
```

**Direct MongoDB query injection:**
```javascript
// entries/index.js - req.query.find used directly
req.query.find = req.query.find || {};
req.query.find.type = req.params.type;
// Later passed to MongoDB collection.find()
```

**No protection against expensive queries:**
- No maximum count limits enforced
- No date range restrictions
- No query complexity analysis

### 2.2 Real-World Impact

| Issue | Impact | Frequency |
|-------|--------|-----------|
| `count=999999` queries | Memory exhaustion, slow responses | Common |
| Malformed date filters | Query failures, 500 errors | Occasional |
| Unbounded devicestatus fetch | Database overload | Common with AAPS |
| MongoDB operator injection | Potential data exfiltration | Unknown |

---

## 3. Design Goals

1. **Consistent parsing** - All query params parsed identically across API versions
2. **Safe defaults** - Missing/invalid params get sensible defaults, not errors
3. **Bounded queries** - Enforce maximum limits to prevent self-inflicted DDoS
4. **Injection prevention** - Sanitize MongoDB query operators
5. **Auth-aware limits** - Higher limits for authenticated/admin users
6. **Graceful rollout** - Log violations before enforcing, minimize client breakage
7. **Observability** - Track violation patterns to inform limit tuning

---

## 4. Architecture

### 4.1 Shared Library

**Location:** `lib/api/shared/query-normalize.js`

```
┌─────────────────────────────────────────────────────────────┐
│                    query-normalize.js                        │
├─────────────────────────────────────────────────────────────┤
│  Type Coercion          │  Sanitization                     │
│  ─────────────          │  ────────────                     │
│  • toPositiveInt()      │  • sanitizeFindQuery()            │
│  • toNonNegativeInt()   │  • allowedFields whitelist        │
│  • toDateRange()        │  • blockedOperators blacklist     │
│  • toBoolean()          │  • depth limiting                 │
├─────────────────────────────────────────────────────────────┤
│  Limit Enforcement      │  Violation Logging                │
│  ─────────────────      │  ─────────────────                │
│  • applyCollectionLimits()  │  • logViolation()             │
│  • getAuthTierMultiplier()  │  • ViolationTypes enum        │
│  • clampToMax()             │  • warn vs enforce mode       │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Integration Pattern

**v1/v2 (Middleware):**
```javascript
const { normalizeQuery } = require('../shared/query-normalize');

router.get('/entries', normalizeQuery('entries'), function(req, res) {
  // req.query is now normalized and safe
  // req.queryViolations contains any violations (for logging)
});
```

**v3 (Schema Validation):**
```javascript
const { validateV3Query, collectionLimits } = require('../shared/query-normalize');

// v3 already has structured params, just add validation
const validated = validateV3Query(req.query, 'entries', authTier);
```

---

## 5. Limit Configuration

### 5.1 Per-Collection Defaults

| Collection | Default Count | Max Count | Max Date Range | Notes |
|------------|---------------|-----------|----------------|-------|
| entries | 10 | 1000 | 30 days | High volume, CGM readings |
| treatments | 10 | 500 | 90 days | Lower volume |
| devicestatus | 10 | 100 | 7 days | Very high volume, AAPS uploads frequently |
| profile | 1 | 50 | N/A | Rarely queried in bulk |
| food | 10 | 500 | N/A | Static reference data |
| activity | 10 | 200 | 30 days | Moderate volume |

### 5.2 Auth Tier Multipliers

| Auth Level | Detection | Count Multiplier | Date Range Multiplier |
|------------|-----------|------------------|----------------------|
| Anonymous | No token/secret | 1x | 1x |
| Authenticated | Valid token with limited perms | 2x | 2x |
| Admin | API_SECRET or `*` permission | 5x | 5x |

**Effective limits example (entries):**

| Auth Level | Max Count | Max Date Range |
|------------|-----------|----------------|
| Anonymous | 1000 | 30 days |
| Authenticated | 2000 | 60 days |
| Admin | 5000 | 150 days |

### 5.3 Auth Tier Derivation

The auth tier is derived from existing authorization middleware. Integration points:

**Location:** `lib/authorization/index.js`

```javascript
function getAuthTier(req) {
  // Check if request has been authorized
  if (!req.isAuthorized) {
    return 'anonymous';
  }
  
  // Check for admin/API_SECRET access
  // req.authedSubject is populated by authorization middleware
  if (req.authedSubject && req.authedSubject.accessToken === 'admin') {
    return 'admin';
  }
  
  // Check for wildcard permission (full access)
  if (req.authedSubject && hasPermission(req.authedSubject, '*')) {
    return 'admin';
  }
  
  // Valid token with limited permissions
  return 'authenticated';
}
```

**Integration with existing auth flow:**

1. Request arrives at API endpoint
2. Existing `authorization.isPermitted()` middleware runs
3. Sets `req.isAuthorized`, `req.authedSubject`, `req.authedRoles`
4. Query normalization middleware calls `getAuthTier(req)`
5. Auth tier determines limit multipliers

**No changes to auth middleware required** - we read existing state only.

### 5.4 Configuration

Limits configurable via environment variables:

```bash
# Override default limits
QUERY_LIMIT_ENTRIES_MAX=2000
QUERY_LIMIT_DEVICESTATUS_MAX=50

# Global multiplier (for constrained deployments)
QUERY_LIMIT_GLOBAL_MULTIPLIER=0.5

# Mode: warn (log only) or enforce (reject/clamp)
QUERY_LIMITS_MODE=warn
```

---

## 6. Query Sanitization

### 6.1 Allowed Fields (Whitelist)

Per-collection whitelists of fields that can appear in `find` queries:

```javascript
const allowedFields = {
  entries: ['type', 'date', 'dateString', 'sgv', 'mbg', 'direction', 'device', '_id'],
  treatments: ['eventType', 'created_at', 'enteredBy', 'insulin', 'carbs', '_id'],
  devicestatus: ['device', 'created_at', 'uploaderBattery', '_id'],
  profile: ['defaultProfile', 'startDate', '_id']
};
```

### 6.2 Blocked Operators (Blacklist)

MongoDB operators that are never allowed:

```javascript
const blockedOperators = [
  '$where',      // JavaScript execution
  '$function',   // User-defined functions
  '$accumulator', // Aggregation with JS
  '$expr',       // Expression evaluation (limited allow)
  '$jsonSchema', // Schema validation bypass
  '$text',       // Full-text search (expensive)
  '$regex'       // Regex (allow only with restrictions)
];
```

### 6.3 Safe Operators (Allowlist)

Operators explicitly allowed in queries:

```javascript
const safeOperators = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin', '$exists', '$type',
  '$and', '$or', '$not'  // Logical with depth limit
];
```

### 6.4 Query Depth Limiting

Prevent deeply nested queries:

```javascript
const MAX_QUERY_DEPTH = 3;
const MAX_ARRAY_LENGTH = 100;  // For $in/$nin arrays
```

---

## 7. Pagination Metadata

### 7.1 Current State

API v1/v2 responses return raw arrays with no pagination metadata:

```json
[
  { "sgv": 120, "date": 1234567890000 },
  { "sgv": 118, "date": 1234567830000 }
]
```

Clients cannot determine:
- Total number of matching documents
- Whether more results exist
- How to fetch the next page

### 7.2 Proposed Response Format

Add optional pagination envelope (backwards compatible):

**Request with pagination metadata:**
```http
GET /api/v1/entries?count=10&skip=0&envelope=true
```

**Response:**
```json
{
  "status": 200,
  "result": [
    { "sgv": 120, "date": 1234567890000 },
    { "sgv": 118, "date": 1234567830000 }
  ],
  "pagination": {
    "count": 10,
    "skip": 0,
    "total": 2847,
    "hasMore": true
  }
}
```

**Request without envelope (default, backwards compatible):**
```http
GET /api/v1/entries?count=10
```

**Response (unchanged):**
```json
[
  { "sgv": 120, "date": 1234567890000 },
  { "sgv": 118, "date": 1234567830000 }
]
```

### 7.3 Implementation Notes

- `envelope=true` query param opts into new format
- `total` count requires additional query (optional, expensive)
- `hasMore` can be determined by requesting count+1, returning count
- v3 already has envelope format, add `pagination` field

### 7.4 Performance Consideration

Total count queries can be expensive on large collections. Options:

| Approach | Trade-off |
|----------|-----------|
| Always include total | Slow on large collections |
| Include only if < 10k docs | Fast but inconsistent |
| Require explicit `&total=true` | Opt-in for expensive operation |
| Estimate using collection stats | Fast but approximate |

**Recommendation:** Require `&total=true` for total count, default to `hasMore` only.

---

## 8. Date Format Normalization

### 8.1 Current State

Date fields are handled inconsistently:

| Field | Format | Notes |
|-------|--------|-------|
| `date` | Unix timestamp (ms) | Number |
| `dateString` | ISO 8601 | String |
| `created_at` | ISO 8601 | String |
| `srvCreated` | Unix timestamp (ms) | Number |
| Query `date[gte]` | Accepts multiple formats | Inconsistent parsing |

### 8.2 Proposed Normalization

**Input parsing (queries):**

```javascript
function parseDate(value) {
  if (value === undefined || value === null) return null;
  
  // Unix timestamp (ms)
  if (typeof value === 'number') return value;
  if (/^\d{13}$/.test(value)) return parseInt(value, 10);
  
  // Unix timestamp (seconds) - common mistake
  if (/^\d{10}$/.test(value)) return parseInt(value, 10) * 1000;
  
  // ISO 8601
  const parsed = Date.parse(value);
  if (!isNaN(parsed)) return parsed;
  
  return null;  // Invalid, will be filtered out
}
```

**Output normalization:**

All date fields in responses include both formats:

```json
{
  "date": 1234567890000,
  "dateString": "2009-02-13T23:31:30.000Z"
}
```

### 8.3 Query Date Filters

Standardize date filter parsing across all endpoints:

```javascript
// Accept multiple formats
const validFormats = [
  'date[gte]=1234567890000',           // Unix ms
  'date[gte]=2024-01-01T00:00:00Z',    // ISO 8601
  'date[gte]=2024-01-01',              // Date only (start of day UTC)
  'dateString[gte]=2024-01-01T00:00:00Z'  // Explicit dateString
];

// Normalize all to Unix ms internally
```

---

## 9. Observability Plan

### 9.1 Violation Logging

Violations are logged to console in structured JSON format for ingestion by log aggregators:

```javascript
console.log(JSON.stringify({
  event: 'query_violation',
  timestamp: new Date().toISOString(),
  violation: 'count_exceeded',
  collection: 'entries',
  endpoint: '/api/v1/entries',
  requested: 50000,
  limit: 1000,
  authTier: 'anonymous',
  clientIP: hashIP(req.ip),  // Anonymized
  userAgent: req.headers['user-agent'],
  action: 'warn'
}));
```

### 9.2 Metrics for Monitoring

| Metric | Type | Labels |
|--------|------|--------|
| `nightscout_query_violations_total` | Counter | `violation_type`, `collection`, `auth_tier`, `action` |
| `nightscout_query_limit_hits_total` | Counter | `collection`, `auth_tier` |
| `nightscout_query_count_requested` | Histogram | `collection` |
| `nightscout_query_date_range_days` | Histogram | `collection` |

### 9.3 Dashboard Recommendations

**Violation Dashboard:**
- Violations per hour by type
- Top violating endpoints
- Auth tier distribution of violations
- User agent breakdown (identify misbehaving clients)

**Query Pattern Dashboard:**
- Requested count distribution per collection
- Date range distribution per collection
- Percentage of queries hitting limits

### 9.4 Alerting Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High violation rate | > 100 violations/minute | Warning |
| Blocked operator detected | Any `blocked_operator` violation | Critical |
| Single client abuse | > 50 violations/minute from one IP | Warning |
| Limit too restrictive | > 50% of queries clamped | Info |

### 9.5 Integration Points

**For deployments with monitoring infrastructure:**

```javascript
// Optional Prometheus integration
if (process.env.ENABLE_PROMETHEUS_METRICS) {
  const { violationsCounter, queryHistogram } = require('./metrics');
  violationsCounter.inc({ type, collection, tier, action });
}

// Optional external logging (Datadog, Splunk, etc.)
if (process.env.EXTERNAL_LOG_ENDPOINT) {
  sendToExternalLogger(violationEvent);
}
```

**For basic deployments:**
- Console JSON logs are sufficient
- Can be piped to file: `node server.js 2>&1 | tee /var/log/nightscout.log`
- grep/jq analysis: `grep query_violation /var/log/nightscout.log | jq '.violation'`

---

## 10. Rollout Strategy

### Phase 1: Warn Mode (Default)

```
QUERY_LIMITS_MODE=warn
```

Behavior:
- Parse and validate all queries
- Log violations to console/monitoring
- **Do not reject or modify queries**
- Collect metrics on violation patterns

Duration: 2-4 weeks to gather data

### Phase 2: Soft Enforce Mode

```
QUERY_LIMITS_MODE=soft
```

Behavior:
- Clamp values to limits (don't reject)
- Log when clamping occurs
- Return `X-Query-Modified: true` header when clamped

### Phase 3: Enforce Mode

```
QUERY_LIMITS_MODE=enforce
```

Behavior:
- Reject queries that exceed limits
- Return 400 Bad Request with clear error message
- Continue logging for monitoring

---

## 11. Error Responses

### 11.1 Validation Error (400)

```json
{
  "status": 400,
  "message": "Query validation failed",
  "errors": [
    {
      "field": "count",
      "violation": "count_exceeded",
      "requested": 50000,
      "maximum": 1000,
      "suggestion": "Use count=1000 or paginate with skip parameter"
    }
  ]
}
```

### 11.2 Modified Query Header

When in soft-enforce mode:

```http
HTTP/1.1 200 OK
X-Query-Modified: true
X-Query-Modifications: count:50000->1000
```

---

## 12. API Version Integration

### 12.1 API v1 Integration Points

| Endpoint | File | Integration Point |
|----------|------|-------------------|
| `/api/v1/entries` | `lib/api/entries/index.js` | Before `prepareQuery()` |
| `/api/v1/treatments` | `lib/api/treatments/index.js` | Before query execution |
| `/api/v1/devicestatus` | `lib/api/devicestatus/index.js` | Before query execution |
| `/api/v1/profile` | `lib/api/profile/index.js` | Before query execution |
| `/api/v1/food` | `lib/api/food/index.js` | Before query execution |
| `/api/v1/activity` | `lib/api/activity/index.js` | Before query execution |

### 12.2 API v2 Integration Points

| Endpoint | File | Integration Point |
|----------|------|-------------------|
| `/api/v2/properties` | `lib/api2/properties/index.js` | Before query execution |
| `/api/v2/authorization/*` | `lib/api2/authorization/index.js` | Subject queries |

### 12.3 API v3 Integration Points

v3 already has structured query handling in `lib/api3/generic/`. Integration adds:

| Component | File | Changes |
|-----------|------|---------|
| Search input | `lib/api3/generic/search/input.js` | Add Zod validation |
| Collection | `lib/api3/generic/collection.js` | Apply limits after parsing |
| Operation | `lib/api3/generic/operation.js` | Violation logging |

---

## 13. Testing Strategy

### 13.1 Unit Tests

**Location:** `tests/api.query-normalize.test.js`

| Test Category | Coverage |
|---------------|----------|
| Type coercion | All parser functions with edge cases |
| Sanitization | Blocked operators, unknown fields |
| Limit enforcement | All collection limits, auth tiers |
| Violation logging | All violation types |

### 13.2 Integration Tests

| Test Category | Coverage |
|---------------|----------|
| v1 endpoints | Each endpoint with limit violations |
| v2 endpoints | Each endpoint with limit violations |
| v3 endpoints | Schema validation failures |
| Auth tier behavior | Anonymous vs authenticated vs admin |
| Mode switching | Warn vs soft vs enforce modes |

### 13.3 Regression Tests

Ensure existing client behavior is preserved in warn mode:
- xDrip queries still work
- Loop queries still work
- AAPS queries still work
- Careportal queries still work

---

## 14. Implementation Phases

### Phase 1: Core Library

**Complexity:** Low | **Risk:** Low | **Dependencies:** None

- [ ] Create `lib/api/shared/query-normalize.js`
- [ ] Implement type coercion functions
- [ ] Implement sanitization functions
- [ ] Implement limit configuration
- [ ] Add unit tests

*Straightforward utility code with well-defined behavior. Low risk because it's new code with no existing dependencies.*

### Phase 2: v1 Integration

**Complexity:** Medium | **Risk:** Medium | **Dependencies:** Phase 1

- [ ] Add middleware to entries endpoint
- [ ] Add middleware to treatments endpoint
- [ ] Add middleware to devicestatus endpoint
- [ ] Add middleware to profile endpoint
- [ ] Add middleware to remaining v1 endpoints
- [ ] Integration tests

*Medium complexity due to varied query patterns across endpoints. Medium risk because v1 is heavily used by uploaders (xDrip, Loop, AAPS).*

### Phase 3: v2 Integration

**Complexity:** Low | **Risk:** Low | **Dependencies:** Phase 1

- [ ] Add middleware to v2 endpoints
- [ ] Integration tests

*Fewer endpoints, similar patterns to v1. Lower risk because v2 is less frequently used directly by clients.*

### Phase 4: v3 Integration

**Complexity:** Medium-High | **Risk:** Low | **Dependencies:** Phase 1

- [ ] Add Zod schemas for v3 query params
- [ ] Integrate validation in search/input.js
- [ ] Apply same limits as v1/v2
- [ ] Integration tests

*Higher complexity because v3 has structured query handling that needs schema overlay. Lower risk because v3 already has better input handling and fewer legacy clients.*

### Phase 5: Rollout

**Complexity:** Low | **Risk:** Variable | **Dependencies:** Phases 2-4

- [ ] Deploy in warn mode
- [ ] Monitor violation logs
- [ ] Tune limits based on real-world data
- [ ] Document enforced limits in API docs
- [ ] Switch to enforce mode

*Low implementation complexity but variable operational risk depending on real-world query patterns. Warn mode mitigates this.*

### Phase Summary

| Phase | Complexity | Risk | Blocking |
|-------|------------|------|----------|
| 1. Core Library | Low | Low | None |
| 2. v1 Integration | Medium | Medium | Phase 1 |
| 3. v2 Integration | Low | Low | Phase 1 |
| 4. v3 Integration | Medium-High | Low | Phase 1 |
| 5. Rollout | Low | Variable | Phases 2-4 |

*Note: Phases 2, 3, and 4 can proceed in parallel after Phase 1 is complete.*

---

## 15. Migration Risks

### 15.1 Known High-Volume Clients

| Client | Concern | Mitigation |
|--------|---------|------------|
| xDrip | May request large entry counts | Auth tier gives 2x limit |
| Loop | Frequent devicestatus uploads | Focus on query limits, not write limits |
| AAPS | Very frequent queries | Socket subscription reduces query need |
| Careportal | Dashboard data fetches | Review actual query patterns |

### 15.2 Rollback Plan

If significant issues detected:
1. Set `QUERY_LIMITS_MODE=off` to disable entirely
2. Or increase specific limits via env vars
3. No code deployment needed for rollback

---

## 16. Open Questions

### 16.1 Resolved

| Question | Decision |
|----------|----------|
| Should we log violations by default? | Yes, warn mode is default |
| Should authenticated users get higher limits? | Yes, tiered multipliers |
| Should v3 be included? | Yes, same collections deserve same protections |

### 16.2 Open

| Question | Notes |
|----------|-------|
| Exact limit values | Need production data from warn mode |
| GraphQL exploration for v4? | Deferred to Control Plane RFC |
| Per-client rate limiting | Separate from per-query limits, may be Phase 2 |

---

## 17. Related Documents

- [API Layer Audit](../audits/api-layer-audit.md) - Documents the issues this proposal addresses
- [Security Audit](../audits/security-audit.md) - Related security concerns
- [Agent Control Plane RFC](./agent-control-plane-rfc.md) - Future API direction
- [Modernization Roadmap](../meta/modernization-roadmap.md) - Overall modernization context

---

## 18. Appendix: Example Implementations

### A.1 Type Coercion Functions

```javascript
function toPositiveInt(value, defaultValue, options = {}) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  
  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }
  
  if (options.max && parsed > options.max) {
    return options.clamp ? options.max : defaultValue;
  }
  
  return parsed;
}

function toDateRange(gte, lte, maxRangeDays) {
  const now = Date.now();
  
  let startDate = gte ? Date.parse(gte) : null;
  let endDate = lte ? Date.parse(lte) : now;
  
  if (startDate && isNaN(startDate)) startDate = null;
  if (isNaN(endDate)) endDate = now;
  
  // Enforce max range
  const maxRangeMs = maxRangeDays * 24 * 60 * 60 * 1000;
  if (startDate && (endDate - startDate) > maxRangeMs) {
    startDate = endDate - maxRangeMs;
  }
  
  return { startDate, endDate };
}
```

### A.2 Query Sanitization

```javascript
function sanitizeFindQuery(query, collection, options = {}) {
  const allowed = allowedFields[collection] || [];
  const violations = [];
  
  function sanitizeValue(key, value, depth = 0) {
    if (depth > MAX_QUERY_DEPTH) {
      violations.push({ type: 'query_too_deep', key, depth });
      return undefined;
    }
    
    if (typeof value === 'object' && value !== null) {
      const sanitized = {};
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('$')) {
          if (blockedOperators.includes(k)) {
            violations.push({ type: 'blocked_operator', operator: k });
            continue;
          }
          if (!safeOperators.includes(k)) {
            violations.push({ type: 'unknown_operator', operator: k });
            continue;
          }
        }
        const sanitizedValue = sanitizeValue(k, v, depth + 1);
        if (sanitizedValue !== undefined) {
          sanitized[k] = sanitizedValue;
        }
      }
      return Object.keys(sanitized).length > 0 ? sanitized : undefined;
    }
    
    return value;
  }
  
  const sanitized = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (!allowed.includes(key) && !key.startsWith('$')) {
      violations.push({ type: 'unknown_field', field: key });
      continue;
    }
    const sanitizedValue = sanitizeValue(key, value);
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }
  
  return { query: sanitized, violations };
}
```
