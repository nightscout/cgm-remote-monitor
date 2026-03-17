# Security Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** Authentication, authorization, event bus security, API secret management

---

## 1. Executive Summary

The Nightscout security model has evolved across API versions, progressing from simple API_SECRET authentication to a sophisticated role-based JWT system. This audit examines the current security architecture, identifies vulnerabilities, and recommends improvements.

### Security Posture Summary

| Component | Current State | Risk Level | Priority |
|-----------|--------------|------------|----------|
| API_SECRET handling | Adequate | Medium | Medium |
| JWT implementation | Good | Low | Low |
| Permission model (Shiro) | Good | Low | Low |
| Auth brute-force protection | **Implemented** (IP delay list) | Low | Low |
| General API rate limiting | Not Implemented | Medium | Medium |
| Event bus security | Minimal | Medium | Medium |
| Input validation | Inconsistent | High | High |

---

## 2. Authentication Mechanisms

### 2.1 API_SECRET Authentication

**Location:** `lib/authorization/index.js`, `lib/server/env.js`

**Implementation:**
```javascript
function authorizeAdminSecret (secret) {
  return env.enclave.isApiKey(secret);
}
```

**Flow:**
1. Client sends `api-secret` header or `secret` query parameter
2. Server compares against stored API_SECRET hash
3. If match, client receives full admin permissions (`*`)

**Security Considerations:**
- API_SECRET is hashed using SHA-1 (adequate but dated)
- Transmitted in headers - OK over HTTPS, risky over HTTP
- Single secret grants full admin access (no granularity)

**Recommendations:**
- Migrate to SHA-256 or bcrypt for secret comparison
- Add API_SECRET rotation mechanism
- Consider deprecating API_SECRET for role-based tokens

### 2.2 Access Token Authentication

**Location:** `lib/authorization/storage.js`

Access tokens are pre-generated identifiers tied to subjects (users/devices).

**Token Generation:**
```javascript
// Tokens are derived from API_SECRET + subject name
function generateAccessToken(subjectName) {
  const hash = crypto.createHash('sha1');
  hash.update(apiSecret + subjectName);
  return subjectName.replace(' ', '-').toLowerCase() + '-' + hash.digest('hex').substring(0, 16);
}
```

**Security Considerations:**
- Deterministic token generation (predictable if API_SECRET compromised)
- Tokens never expire until manually revoked
- Stored in MongoDB `auth_subjects` collection

**Recommendations:**
- Add token expiration
- Implement cryptographically random token generation
- Add token revocation audit logging

### 2.3 JWT Authentication

**Location:** `lib/authorization/index.js`, `lib/server/enclave.js`

**Implementation:**
```javascript
const verified = env.enclave.verifyJWT(data.token);
token = verified.accessToken;
```

**JWT Structure:**
```json
{
  "accessToken": "subject-access-token",
  "iat": 1234567890,
  "exp": 1234571490
}
```

**Security Considerations:**
- JWTs signed with API_SECRET (HMAC-SHA256)
- Default expiration: 1 hour
- No refresh token mechanism

**Recommendations:**
- Implement refresh tokens for long-lived sessions
- Add JWT revocation list (for logout)
- Consider asymmetric signing (RS256) for distributed systems

---

## 3. Authorization Model

### 3.1 Shiro-Trie Permission System

**Location:** `lib/authorization/`, uses `shiro-trie` package

The authorization system uses Apache Shiro-style permissions with a trie data structure for efficient permission checking.

**Permission Format:**
```
domain:action:instance

Examples:
api:entries:read         - Read entries
api:treatments:create    - Create treatments
api:*:*                  - All API operations
*                        - Full admin access
```

**Permission Hierarchy:**

```
Subject (user/device)
    ↓
Roles (readable, denied, admin, etc.)
    ↓
Permissions (api:entries:read, etc.)
    ↓
Shiro Trie (wildcard matching)
```

### 3.2 Default Roles

**Location:** `lib/authorization/storage.js`

| Role | Permissions | Description |
|------|-------------|-------------|
| `admin` | `*` | Full access |
| `readable` | `api:*:read`, `notifications:*:ack` | Read-only access |
| `denied` | (none) | No permissions |
| `careportal` | `api:treatments:create` | Can add treatments |
| `devicestatus-upload` | `api:devicestatus:create` | Loop/pump status upload |
| `activity-create` | `api:activity:create` | Activity logging |

### 3.3 Default Permissions

**Configuration:** `AUTH_DEFAULT_ROLES` environment variable

| Setting | Effect |
|---------|--------|
| `readable` | Unauthenticated users can read data |
| `denied` | Unauthenticated users have no access |
| (custom) | Comma-separated role names |

**Security Risk:** Many installations set `readable` as default, exposing patient data publicly.

**Recommendations:**
- Default to `denied` in new installations
- Add prominent warning when `readable` is enabled
- Implement IP whitelisting for read access

---

## 4. Event Bus Security

### 4.1 Current Implementation

**Location:** `lib/bus.js`

The event bus is a Node.js Stream used for internal pub/sub communication.

```javascript
var stream = new Stream;
stream.emit('notification', notify);
ctx.bus.on('data-update', handler);
```

**Security Characteristics:**
- **No authentication:** Any code with `ctx` reference can emit/listen
- **No authorization:** No permission checks on events
- **No encryption:** Events contain plaintext data
- **No rate limiting:** Unlimited event emission

### 4.2 Event Types and Sensitivity

| Event | Data Sensitivity | Risk |
|-------|-----------------|------|
| `tick` | Low (heartbeat) | Low |
| `data-update` | High (glucose data) | Medium |
| `notification` | High (patient alerts) | Medium |
| `admin-notify` | Medium (auth failures) | Low |
| `teardown` | Low (shutdown) | Low |

### 4.3 Security Gaps

1. **Plugin Isolation:** Plugins can subscribe to any event
2. **Event Injection:** Compromised plugin can emit fake events
3. **Data Leakage:** Sensitive data passed through events without sanitization
4. **No Audit Trail:** Events not logged for security analysis

**Recommendations:**
- Implement event namespace isolation for plugins
- Add event schema validation
- Create audit log for sensitive events
- Consider replacing with typed EventEmitter

---

## 5. API Security

### 5.1 Input Validation

**Current State:** Inconsistent across API versions

| API Version | Validation | Notes |
|-------------|------------|-------|
| v1 | Minimal | Basic type checking |
| v2 | Moderate | Some Joi schemas |
| v3 | Better | OpenAPI validation |

**Identified Gaps:**
- No consistent validation middleware
- Some endpoints accept arbitrary JSON
- MongoDB injection possible in some queries

**Example Vulnerable Pattern:**
```javascript
// Potential NoSQL injection
collection.find({ type: req.query.type });
```

**Recommendations:**
- Implement centralized validation middleware (Zod/Joi)
- Add request sanitization layer
- Enable MongoDB strict mode

### 5.2 Rate Limiting & Brute-Force Protection

#### 5.2.1 Authentication Brute-Force Protection (Implemented)

**Location:** `lib/authorization/delaylist.js`

**Implementation:**
```javascript
const DELAY_ON_FAIL = settings.authFailDelay || 5000;  // Configurable via env
const FAIL_AGE = 60000;  // Clear after 1 minute

ipDelayList.addFailedRequest(ip);      // Add cumulative delay
ipDelayList.shouldDelayRequest(ip);    // Check if request should be delayed
ipDelayList.requestSucceeded(ip);      // Clear delay on success
```

**Behavior:**
- Tracks failed authentication attempts by IP address
- Adds progressive delays (default 5000ms per failure, cumulative)
- Configurable via `authFailDelay` setting (useful for faster tests)
- Auto-clears entries after 60 seconds of inactivity
- Immediately clears IP on successful authentication

**Strengths:**
- Effective brute-force protection for authentication endpoints
- Progressive delay makes automated attacks impractical
- Configurable for different environments

#### 5.2.2 General API Rate Limiting (Not Implemented)

**Current State:** No rate limiting for general API endpoints

**Gaps:**
- Unauthenticated endpoints have no request limits
- Authenticated users can make unlimited requests
- No protection against API abuse or scraping

**Recommendations:**
- Add express-rate-limit middleware for general API protection
- Implement per-endpoint rate limits for expensive operations
- Add request size limits
- Consider Redis-based distributed rate limiting for multi-instance deployments

### 5.3 CORS Configuration

**Location:** `lib/server/app.js`

**Current State:** CORS enabled for all origins by default.

**Recommendations:**
- Allow configuring allowed origins
- Restrict credentials mode
- Add CORS preflight caching

### 5.4 Security Headers

**Location:** `lib/server/app.js` (uses `helmet` package)

**Current Headers (via Helmet 4.x):**
- Content-Security-Policy
- X-Frame-Options
- X-Content-Type-Options
- Strict-Transport-Security (HSTS)

**Recommendations:**
- Review and tighten CSP rules
- Add Permissions-Policy header
- Enable Report-Only mode for CSP testing

---

## 6. Socket.IO Security

### 6.1 Authentication

**Location:** `lib/api3/storageSocket.js`, `lib/api3/alarmSocket.js`

**Implementation:**
```javascript
socket.on('subscribe', function onSubscribe (message, returnCallback) {
  if (message && message.accessToken) {
    return ctx.authorization.resolveAccessToken(message.accessToken, ...);
  }
});
```

**Security Characteristics:**
- Requires `accessToken` for subscription
- Token validated against authorization system
- Per-collection permission checks for `/storage`

### 6.2 Authorization

| Namespace | Required Permission |
|-----------|---------------------|
| `/storage` | `api:{collection}:read` |
| `/alarm` | (any valid token) |

### 6.3 Security Gaps

1. **Connection without auth:** Clients can connect without authentication
2. **No message signing:** Messages can be tampered
3. **Broadcast scope:** Alarms broadcast to all subscribed clients

**Recommendations:**
- Require authentication on connection
- Add message integrity verification
- Implement fine-grained alarm subscriptions

---

## 7. Data Protection

### 7.1 Sensitive Data Categories

| Category | Examples | Current Protection |
|----------|----------|-------------------|
| PHI (Protected Health Information) | Glucose readings, treatments | Encryption at rest (MongoDB) |
| Authentication secrets | API_SECRET, tokens | Environment variables |
| Session data | JWTs | Signed, not encrypted |
| User preferences | Time zone, units | Stored in profile collection |

### 7.2 Data Encryption

**At Rest:**
- MongoDB encryption depends on deployment
- No application-level encryption

**In Transit:**
- HTTPS recommended but not enforced
- Socket.IO uses same transport as HTTP

**Recommendations:**
- Require HTTPS in production
- Add application-level encryption for sensitive fields
- Implement key rotation mechanism

### 7.3 Data Retention

- No automatic data expiration
- `autoPrune` feature in API v3 (configurable days)
- No GDPR-specific data deletion

**Recommendations:**
- Implement configurable data retention policies
- Add data export functionality
- Create data deletion audit trail

---

## 8. Vulnerability Assessment

### 8.1 Known Vulnerabilities

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| NS-SEC-001 | API_SECRET transmitted in query params | Medium | Open |
| NS-SEC-002 | No brute force protection on API | Medium | Partial |
| NS-SEC-003 | XSS possible in announcement messages | Low | Open |
| NS-SEC-004 | Deprecated `request` library | Low | Open |

### 8.2 Threat Model

**Threat Actors:**
1. Unauthenticated attackers (internet)
2. Authenticated low-privilege users
3. Compromised plugins/bridges
4. Malicious caregivers

**Attack Vectors:**
1. Brute force API_SECRET
2. Token theft via XSS
3. Data injection via unsanitized input
4. Denial of service via resource exhaustion

---

## 9. Compliance Considerations

### 9.1 HIPAA

Nightscout handles Protected Health Information (PHI):
- Requires HTTPS in production
- Needs access audit logging
- Must support user access controls

### 9.2 GDPR

For EU users:
- Data export (partial support via API)
- Data deletion (not automated)
- Consent management (not implemented)

---

## 10. Recommendations Summary

### Critical (Immediate)

1. **Add input validation middleware** - Prevent injection attacks
2. **Implement API rate limiting** - Prevent DoS attacks
3. **Enforce HTTPS in production** - Protect data in transit

### High Priority (1-3 months)

4. **Replace deprecated `request` library** - Security maintenance
5. **Add comprehensive audit logging** - Compliance requirement
6. **Implement token rotation** - Reduce exposure window

### Medium Priority (3-6 months)

7. **Migrate API_SECRET hashing to SHA-256** - Stronger security
8. **Add event bus isolation** - Plugin security
9. **Implement GDPR data deletion** - Compliance

### Low Priority (6+ months)

10. **Consider asymmetric JWT signing** - Distributed deployment
11. **Add multi-factor authentication** - Enhanced security
12. **Implement security scanning in CI** - Automated vulnerability detection

---

## 11. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [API Layer Audit](./api-layer-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)
