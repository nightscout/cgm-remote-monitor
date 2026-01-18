# API Layer Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** REST API v1/v2/v3, WebSocket protocols, versioning strategy

---

## 1. Executive Summary

Nightscout provides three REST API versions with increasing sophistication. This audit documents endpoint inventories, authentication patterns, response formats, and modernization opportunities.

### API Version Comparison

| Feature | API v1 | API v2 | API v3 |
|---------|--------|--------|--------|
| Base Path | `/api/v1` | `/api/v2` | `/api/v3` |
| Auth Method | API_SECRET | JWT/Token | JWT/Token |
| Documentation | Partial | Partial | OpenAPI 3.0 |
| Response Format | Mixed | JSON | JSON |
| Error Handling | Inconsistent | Better | Standardized |
| Status | Legacy | Current | Recommended |

---

## 2. API v1 (`/api/v1`)

**Location:** `lib/api/`

### 2.1 Endpoint Inventory

#### Entries (Glucose Readings)

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/entries` | `api:entries:read` | List entries |
| GET | `/entries/{spec}` | `api:entries:read` | Get specific entries |
| GET | `/entries/current` | `api:entries:read` | Latest entry |
| GET | `/entries/sgv` | `api:entries:read` | SGV entries only |
| POST | `/entries` | `api:entries:create` | Create entries |
| DELETE | `/entries/{spec}` | `api:entries:delete` | Delete entries |

**Query Parameters:**
- `count` - Number of results (default: 10)
- `find[field]` - MongoDB-style query
- `date[gte]`, `date[lte]` - Date range filters

#### Treatments

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/treatments` | `api:treatments:read` | List treatments |
| POST | `/treatments` | `api:treatments:create` | Create treatment |
| PUT | `/treatments` | `api:treatments:update` | Update treatment |
| DELETE | `/treatments/{id}` | `api:treatments:delete` | Delete treatment |

#### Device Status

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/devicestatus` | `api:devicestatus:read` | List device statuses |
| POST | `/devicestatus` | `api:devicestatus:create` | Create device status |
| DELETE | `/devicestatus/{id}` | `api:devicestatus:delete` | Delete device status |

#### Profile

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/profile` | `api:profile:read` | Get profiles |
| POST | `/profile` | `api:profile:create` | Create profile |
| DELETE | `/profile/{id}` | `api:profile:delete` | Delete profile |

#### Other Endpoints

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/status` | Public | Server status |
| GET | `/food` | `api:food:read` | Food database |
| GET | `/activity` | `api:activity:read` | Activity log |
| POST | `/notifications/ack` | `notifications:*:ack` | Acknowledge alarm |

### 2.2 Response Format

**Success Response:**
```json
[
  {
    "_id": "5f1234567890abcdef123456",
    "sgv": 120,
    "date": 1595000000000,
    "dateString": "2020-07-17T12:00:00.000Z",
    "trend": 4,
    "direction": "Flat",
    "device": "xDrip-DexcomG6",
    "type": "sgv"
  }
]
```

**Error Response (inconsistent):**
```json
{
  "status": 401,
  "message": "Unauthorized"
}
// or sometimes just HTTP status without body
```

### 2.3 Issues and Recommendations

| Issue | Severity | Recommendation |
|-------|----------|----------------|
| MongoDB query injection via `find` | High | Validate/sanitize query params |
| No pagination metadata | Medium | Add total count, next/prev links |
| Inconsistent error responses | Medium | Standardize error format |
| Mixed date formats | Low | Use ISO 8601 consistently |

---

## 3. API v2 (`/api/v2`)

**Location:** `lib/api2/`

API v2 extends v1 with authorization endpoints and aggregated data.

### 3.1 Additional Endpoints

#### Authorization

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/authorization/request/{token}` | Public | Get JWT for access token |
| GET | `/authorization/subjects` | `admin:*:read` | List subjects |
| POST | `/authorization/subjects` | `admin:*:admin` | Create subject |
| PUT | `/authorization/subjects` | `admin:*:admin` | Update subject |
| DELETE | `/authorization/subjects/{id}` | `admin:*:admin` | Delete subject |
| GET | `/authorization/roles` | `admin:*:read` | List roles |

#### Properties

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/properties` | Public | Get system properties |
| GET | `/properties/{name}` | Varies | Get specific property |

#### Data Endpoints

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/ddata` | `api:*:read` | Aggregated data dump |

### 3.2 JWT Response

**Request:**
```http
GET /api/v2/authorization/request/mytoken-abc123
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "sub": "mytoken",
  "permissionGroups": [
    ["api:entries:read", "api:treatments:read"]
  ],
  "iat": 1595000000,
  "exp": 1595003600
}
```

---

## 4. API v3 (`/api/v3`)

**Location:** `lib/api3/`

API v3 is the most modern implementation with OpenAPI 3.0 documentation.

### 4.1 Generic Collection Operations

All collections (devicestatus, entries, food, profile, settings, treatments) support:

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/{collection}` | `api:{collection}:read` | SEARCH - Query documents |
| POST | `/{collection}` | `api:{collection}:create` | CREATE - Add document |
| GET | `/{collection}/{identifier}` | `api:{collection}:read` | READ - Get single document |
| PUT | `/{collection}` | `api:{collection}:update` | UPDATE - Replace document |
| PATCH | `/{collection}` | `api:{collection}:update` | PATCH - Partial update |
| DELETE | `/{collection}/{identifier}` | `api:{collection}:delete` | DELETE - Remove document |
| GET | `/{collection}/history/{lastModified}` | `api:{collection}:read` | HISTORY - Incremental sync |

### 4.2 Specific Endpoints

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/version` | Public | Software versions |
| GET | `/status` | Varies | Server status |
| GET | `/lastModified` | Varies | Last modification times |

### 4.3 Query Parameters

**SEARCH Operation:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter` | string | MongoDB-style filter (JSON) |
| `sort` | string | Field to sort by (prefix `$` for descending) |
| `limit` | integer | Max results (default: 10, max: 1000) |
| `skip` | integer | Offset for pagination |
| `fields` | string | Comma-separated field projection |

**Example:**
```http
GET /api/v3/entries?sort$desc=date&limit=100&fields=sgv,date,direction
```

### 4.4 Response Format

**Success Response:**
```json
{
  "status": 200,
  "result": [
    {
      "identifier": "abc123-def456",
      "date": 1595000000000,
      "sgv": 120,
      "direction": "Flat",
      "srvCreated": 1595000001000,
      "srvModified": 1595000001000
    }
  ]
}
```

**Error Response:**
```json
{
  "status": 401,
  "message": "Missing or bad access token or JWT"
}
```

### 4.5 OpenAPI Documentation

**Location:** `/api/v3/swagger.yaml`, accessible at `/api3-docs`

**Features:**
- Complete endpoint documentation
- Request/response schemas
- Authentication requirements
- Example payloads

---

## 5. WebSocket Protocols

### 5.1 Legacy WebSocket (`/`)

**Location:** `lib/server/websocket.js`

**Connection:**
```javascript
const socket = io('https://example.com/', {
  query: { token: 'mytoken' }
});
```

**Events (Client → Server):**

| Event | Payload | Description |
|-------|---------|-------------|
| `authorize` | `{ client, secret, token }` | Authenticate connection |
| `ack` | `{ level, group, silenceTime }` | Acknowledge alarm |

**Events (Server → Client):**

| Event | Payload | Description |
|-------|---------|-------------|
| `dataUpdate` | `{ sgvs, treatments, ... }` | Data change notification |
| `alarm` | `{ level, title, message }` | Alarm notification |
| `announcement` | `{ title, message }` | Announcement |
| `clear_alarm` | `{}` | Alarm cleared |

### 5.2 Storage Socket (`/storage`)

**Location:** `lib/api3/storageSocket.js`

**Subscription:**
```javascript
const socket = io('https://example.com/storage');
socket.emit('subscribe', {
  accessToken: 'mytoken-abc123',
  collections: ['entries', 'treatments']
}, callback);
```

**Events (Server → Client):**

| Event | Payload | Description |
|-------|---------|-------------|
| `create` | `{ colName, doc }` | Document created |
| `update` | `{ colName, doc }` | Document updated |
| `delete` | `{ colName, identifier }` | Document deleted |

### 5.3 Alarm Socket (`/alarm`)

**Location:** `lib/api3/alarmSocket.js`

**Subscription:**
```javascript
const socket = io('https://example.com/alarm');
socket.emit('subscribe', {
  accessToken: 'mytoken-abc123'
}, callback);
```

**Events (Server → Client):**

| Event | Payload | Description |
|-------|---------|-------------|
| `announcement` | Notification object | User announcement |
| `alarm` | Notification object | Warning-level alarm |
| `urgent_alarm` | Notification object | Urgent-level alarm |
| `clear_alarm` | `{}` | Alarm cleared |

---

## 6. Authentication Patterns

### 6.1 API v1 Authentication

**Option 1: Header**
```http
GET /api/v1/entries
api-secret: your-api-secret
```

**Option 2: Query Parameter**
```http
GET /api/v1/entries?secret=your-api-secret
```

**Option 3: Access Token**
```http
GET /api/v1/entries?token=mytoken-abc123
```

### 6.2 API v2/v3 Authentication

**Option 1: Bearer Token (Recommended)**
```http
GET /api/v3/entries
Authorization: Bearer eyJhbGciOiJIUzI1NiI...
```

**Option 2: Query Parameter**
```http
GET /api/v3/entries?token=eyJhbGciOiJIUzI1NiI...
```

---

## 7. Error Handling

### 7.1 HTTP Status Codes

| Code | API v1 | API v3 | Meaning |
|------|--------|--------|---------|
| 200 | ✓ | ✓ | Success |
| 201 | ✓ | ✓ | Created |
| 204 | ✓ | ✓ | No Content |
| 304 | - | ✓ | Not Modified |
| 400 | ✓ | ✓ | Bad Request |
| 401 | ✓ | ✓ | Unauthorized |
| 403 | ✓ | ✓ | Forbidden |
| 404 | ✓ | ✓ | Not Found |
| 422 | - | ✓ | Unprocessable Entity |
| 500 | ✓ | ✓ | Internal Error |

### 7.2 Error Response Standards

**API v3 Standard:**
```json
{
  "status": 400,
  "message": "Bad request description",
  "description": "Detailed explanation (optional)"
}
```

**Recommendation:** Apply v3 error format to all API versions.

---

## 8. Performance Considerations

### 8.1 Query Performance

| Operation | Indexed | Typical Response Time |
|-----------|---------|----------------------|
| Get latest entry | Yes | <50ms |
| Search entries by date | Yes | <100ms |
| Search treatments | Yes | <100ms |
| History sync | Partial | 100-500ms |
| Aggregated ddata | No | 500-2000ms |

### 8.2 Rate Limits

**Current State:** No API rate limiting implemented.

**Recommendations:**
| Endpoint Type | Suggested Limit |
|--------------|-----------------|
| Read operations | 60/minute |
| Write operations | 30/minute |
| Auth attempts | 5/minute |
| WebSocket connections | 10/IP |

### 8.3 Payload Sizes

| Endpoint | Typical Size | Max Size |
|----------|-------------|----------|
| Single entry | ~200 bytes | 1KB |
| Entries list (100) | ~20KB | 100KB |
| Device status | ~2KB | 50KB |
| Profile | ~10KB | 100KB |
| ddata dump | ~100KB | 1MB |

---

## 9. Versioning Strategy

### 9.1 Current State

- All three API versions active and maintained
- No formal deprecation timeline
- v1 still most commonly used by uploaders

### 9.2 Recommended Deprecation Path

| Timeline | Action |
|----------|--------|
| Now | Document v3 as recommended API |
| 6 months | Add deprecation warnings to v1 responses |
| 12 months | Mark v1 as deprecated in docs |
| 18 months | Add v1 deprecation header |
| 24 months | Consider v1 removal (with long notice) |

### 9.3 Breaking Changes Policy

- Major version changes for breaking changes
- Minimum 6 months deprecation notice
- Maintain backwards compatibility where possible
- Document migration guides

---

## 10. Issues and Recommendations

### 10.1 Critical Issues

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| No rate limiting | DoS vulnerability | Implement express-rate-limit |
| MongoDB query injection | Security risk | Validate/sanitize all queries |
| No request validation | Data integrity | Add Zod/Joi validation |

### 10.2 Improvements

| Area | Current | Recommended |
|------|---------|-------------|
| Documentation | Partial | Full OpenAPI for all versions |
| Pagination | Limit only | Cursor-based pagination |
| Filtering | MongoDB syntax | GraphQL-like syntax |
| Versioning | URL path | Accept-Version header |
| Caching | None | ETag/Last-Modified headers |

### 10.3 Modernization Opportunities

1. **GraphQL Layer:** Add GraphQL on top of existing REST
2. **API Gateway:** Consider Kong/Express Gateway for rate limiting
3. **Schema Validation:** Enforce JSON schemas on all requests
4. **Response Compression:** Enable gzip/brotli compression
5. **API Metrics:** Add Prometheus metrics for monitoring

---

## 11. Data Shape Handling

**See Also:** [Data Shape Requirements](./requirements/data-shape-requirements.md), [Shape Handling Tests](./test-specs/shape-handling-tests.md)

### 11.1 Input Shape Flexibility

API v1 endpoints accept both single objects and arrays for most collections. This flexibility is critical for client compatibility with AAPS, Loop, and xDrip.

| Collection | Single Object | Array Input | Notes |
|------------|---------------|-------------|-------|
| treatments | Supported | Supported | Normalized to array internally |
| entries | Supported | Supported | xDrip uses for batch backfill |
| devicestatus | Supported | Supported | AAPS sends batches via WebSocket |

### 11.2 Known Issues (Fixed)

1. **devicestatus.js race condition** - Array inputs could lose data due to async loop variable capture. Fixed with `async.eachSeries()`.

2. **WebSocket insertOne with arrays** - MongoDB's `insertOne([a,b])` creates single document. Fixed with sequential processing.

### 11.3 Test Coverage

Shape handling is validated by 38 tests across:
- `tests/api.shape-handling.test.js`
- `tests/websocket.shape-handling.test.js`
- `tests/storage.shape-handling.test.js`

---

## 12. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [Security Audit](./security-audit.md)
- [Real-Time Systems Audit](./realtime-systems-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)

### Requirements & Specifications

- [Data Shape Requirements](../requirements/data-shape-requirements.md) - Formal requirements for input/output shapes
- [API v1 Compatibility Requirements](../requirements/api-v1-compatibility-requirements.md) - Client compatibility requirements
- [Shape Handling Tests](../test-specs/shape-handling-tests.md) - Test case specifications
