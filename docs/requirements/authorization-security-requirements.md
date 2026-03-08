# Authorization and Security Requirements Specification

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft  
**Related Documents:** [Security Audit](../audits/security-audit.md), [API Layer Audit](../audits/api-layer-audit.md)

---

## 1. Purpose

This document formally specifies the authentication and authorization requirements for Nightscout's API system. It serves as a contract for:

1. **Client developers** - Understanding how to authenticate with Nightscout
2. **Maintainers** - Preserving security behavior during refactoring
3. **Testers** - Validating security behavior against formal requirements
4. **Security auditors** - Understanding the expected security posture

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **API_SECRET** | A shared secret (minimum 12 characters) used for admin-level authentication |
| **API_SECRET Hash** | The SHA-1 or SHA-512 digest of the API_SECRET, transmitted instead of the raw secret |
| **Access Token** | A subject-specific token derived from the subject name and a digest of the subject ID |
| **JWT** | JSON Web Token signed with a dedicated JWT signing key for time-limited authentication |
| **JWT Signing Key** | A separate key (loaded from `randomString` file or set via `setJWTKey`) used to sign/verify JWTs |
| **Subject** | An entity (user, device, application) that can authenticate |
| **Role** | A named collection of permissions that can be assigned to subjects |
| **Permission** | An Apache Shiro-style string defining allowed actions (e.g., `api:entries:read`) |
| **Shiro Trie** | A data structure for efficient wildcard permission matching |

---

## 3. Authentication Requirements

### 3.1 API_SECRET Authentication

#### REQ-AUTH-001: API_SECRET Minimum Length

The API_SECRET environment variable MUST be at least 12 characters long.

| Input | Expected Behavior | Requirement ID |
|-------|-------------------|----------------|
| `API_SECRET` ≥ 12 chars | Server starts, secret is valid | REQ-AUTH-001a |
| `API_SECRET` < 12 chars | Server logs error, secret is null | REQ-AUTH-001b |
| `API_SECRET` not set | Server runs with limited functionality | REQ-AUTH-001c |

**Implementation Reference:** `lib/server/env.js`

```javascript
if (readENV('API_SECRET').length < consts.MIN_PASSPHRASE_LENGTH) {
  env.err.push({desc: 'API_SECRET should be at least ' + consts.MIN_PASSPHRASE_LENGTH + ' characters'});
}
```

#### REQ-AUTH-002: API_SECRET Transmission

The API_SECRET MUST be transmitted as a hash (SHA-1 or SHA-512), never in plaintext.

| Method | Header/Parameter | Format | Requirement ID |
|--------|------------------|--------|----------------|
| Header | `api-secret` | SHA-1 (40 chars) or SHA-512 (128 chars) hex string | REQ-AUTH-002a |
| Query | `?secret=` | SHA-1 (40 chars) or SHA-512 (128 chars) hex string | REQ-AUTH-002b |
| Body | `body.secret` | SHA-1 (40 chars) or SHA-512 (128 chars) hex string | REQ-AUTH-002c |

**Example (SHA-1):**
```
API_SECRET: "this is my long pass phrase"
SHA-1 Hash: "b723e97aa97846eb92d5264f084b2823f57c4aa1"
```

**Note:** Either SHA-1 or SHA-512 hashes are accepted per REQ-AUTH-003.

#### REQ-AUTH-003: API_SECRET Hash Algorithms

The system MUST accept both SHA-1 and SHA-512 hashes of the API_SECRET.

| Algorithm | Hash Length | Requirement ID |
|-----------|-------------|----------------|
| SHA-1 | 40 hex chars | REQ-AUTH-003a |
| SHA-512 | 128 hex chars | REQ-AUTH-003b |

**Rationale:** SHA-512 support provides a migration path to stronger hashing.

#### REQ-AUTH-004: API_SECRET Authorization Level

A valid API_SECRET grants full admin permissions (`*`).

**Shiro Permission:** `*` (all permissions)

---

### 3.2 Access Token Authentication

#### REQ-AUTH-010: Access Token Format

Access tokens MUST be derived from the subject name and a digest computed by the enclave.

**Format:** `{abbreviation}-{digest_prefix}`

| Component | Description | Requirement ID |
|-----------|-------------|----------------|
| Abbreviation | First 10 alphanumeric chars of subject name, lowercase | REQ-AUTH-010a |
| Digest Prefix | First 16 chars of digest from `enclave.getSubjectHash(subject._id)` | REQ-AUTH-010b |

**Implementation Detail:** The digest is computed as SHA-1 of `apiKeySHA1 + subject._id`, where `apiKeySHA1` is the SHA-1 hash of the API_SECRET. This double-hashing provides an additional layer of indirection.

**Reference:** `lib/server/enclave.js:getSubjectHash()`

**Example:**
```
Subject Name: "Loop App"
Access Token: "loopapp-a1b2c3d4e5f6g7h8"
```

#### REQ-AUTH-011: Access Token Locations

Access tokens MAY be provided in the following locations:

| Location | Priority | Requirement ID |
|----------|----------|----------------|
| `api-secret` header | 1 (checked if not API_SECRET hash) | REQ-AUTH-011a |
| `?token=` query parameter | 2 | REQ-AUTH-011b |
| `body.token` | 3 | REQ-AUTH-011c |

#### REQ-AUTH-012: Access Token Resolution

When a valid access token is provided, the system MUST:

1. Locate the corresponding subject
2. Retrieve the subject's roles
3. Merge subject roles with default roles
4. Return combined permissions

---

### 3.3 JWT Authentication

#### REQ-AUTH-020: JWT Generation

The system MUST generate JWTs when a valid access token is provided to the authorization endpoint.

| Endpoint | Method | Input | Output | Requirement ID |
|----------|--------|-------|--------|----------------|
| `/api/v2/authorization/request/{token}` | GET | Access token | JWT | REQ-AUTH-020a |

**JWT Payload:**
```json
{
  "accessToken": "subject-access-token",
  "iat": 1705000000,
  "exp": 1705003600
}
```

#### REQ-AUTH-021: JWT Signature

JWTs MUST be signed using HMAC-SHA256 with a dedicated JWT signing key.

**Implementation Detail:** The signing key is stored in `secrets[jwtKey]` and is loaded from a `randomString` file in the cache directory, or can be set via `env.enclave.setJWTKey()`. This is separate from the API_SECRET.

**Reference:** `lib/server/enclave.js:signJWT()`, `lib/server/enclave.js:readKey()`

#### REQ-AUTH-022: JWT Expiration

JWTs MUST have an expiration time. Default: 8 hours.

**Implementation Detail:** The default lifetime is `'8h'` as defined in `enclave.signJWT()`. This can be overridden by passing a custom lifetime parameter.

**Reference:** `lib/server/enclave.js:58`

#### REQ-AUTH-023: JWT Validation

When a JWT is provided, the system MUST:

1. Verify the signature using the JWT signing key (same key used in REQ-AUTH-021)
2. Check expiration time
3. Extract the access token from payload
4. Resolve permissions via access token

**Reference:** `lib/server/enclave.js:verifyJWT()`

#### REQ-AUTH-024: JWT Transmission

JWTs MUST be transmitted via the `Authorization` header.

**Format:** `Authorization: Bearer {jwt}`

| Input | Expected Behavior | Requirement ID |
|-------|-------------------|----------------|
| Valid JWT | Extract access token, resolve permissions | REQ-AUTH-024a |
| Expired JWT | Return 401 Unauthorized | REQ-AUTH-024b |
| Invalid signature | Return 401 Unauthorized | REQ-AUTH-024c |
| Malformed JWT | Return 401 Unauthorized | REQ-AUTH-024d |

---

## 4. Authorization Requirements

### 4.1 Role-Based Access Control

#### REQ-AUTHZ-001: Default Roles

The system MUST provide the following built-in roles:

| Role Name | Permissions | Description | Requirement ID |
|-----------|-------------|-------------|----------------|
| `admin` | `*` | Full access | REQ-AUTHZ-001a |
| `denied` | (none) | No permissions | REQ-AUTHZ-001b |
| `status-only` | `api:status:read` | Read status only | REQ-AUTHZ-001c |
| `readable` | `*:*:read` | Read all data | REQ-AUTHZ-001d |
| `careportal` | `api:treatments:create` | Create treatments | REQ-AUTHZ-001e |
| `devicestatus-upload` | `api:devicestatus:create` | Upload device status | REQ-AUTHZ-001f |
| `activity` | `api:activity:create` | Create activity records | REQ-AUTHZ-001g |

#### REQ-AUTHZ-002: Custom Roles

Administrators MUST be able to create custom roles with arbitrary permission sets.

**Storage:** MongoDB collection `auth_roles`

#### REQ-AUTHZ-003: Default Permissions

Unauthenticated requests MUST receive permissions based on `AUTH_DEFAULT_ROLES` environment variable.

| Setting | Effect | Requirement ID |
|---------|--------|----------------|
| `readable` | Unauthenticated can read all data | REQ-AUTHZ-003a |
| `denied` | Unauthenticated have no permissions | REQ-AUTHZ-003b |
| Comma-separated roles | Merge permissions from listed roles | REQ-AUTHZ-003c |

### 4.2 Shiro Permission Model

#### REQ-AUTHZ-010: Permission Format

Permissions MUST follow the Apache Shiro format: `domain:action:instance`

**Examples:**
```
api:entries:read      - Read entries via API
api:treatments:create - Create treatments
api:*:*               - All API operations
*                     - Full admin access
```

#### REQ-AUTHZ-011: Wildcard Matching

The permission system MUST support wildcard matching at any level.

| Pattern | Matches | Requirement ID |
|---------|---------|----------------|
| `*` | All permissions | REQ-AUTHZ-011a |
| `api:*:*` | All API operations | REQ-AUTHZ-011b |
| `api:entries:*` | All entry operations | REQ-AUTHZ-011c |
| `*:*:read` | All read operations | REQ-AUTHZ-011d |

#### REQ-AUTHZ-012: Permission Checking

Permission checks MUST use the Shiro Trie data structure for efficient wildcard matching.

---

## 5. Brute-Force Protection Requirements

### 5.1 IP-Based Delay List

#### REQ-BRUTE-001: Failed Authentication Tracking

The system MUST track failed authentication attempts by IP address.

**Implementation Reference:** `lib/authorization/delaylist.js`

#### REQ-BRUTE-002: Progressive Delay

After a failed authentication attempt, subsequent requests from the same IP MUST be delayed.

| Parameter | Default Value | Configurable | Requirement ID |
|-----------|---------------|--------------|----------------|
| Delay per failure | 5000ms | Yes (`settings.authFailDelay`) | REQ-BRUTE-002a |
| Delay accumulation | Cumulative | No | REQ-BRUTE-002b |
| Max delay | No limit | No | REQ-BRUTE-002c |

**Behavior:**
```
1st failure: 5 second delay
2nd failure: 10 second delay (cumulative)
3rd failure: 15 second delay (cumulative)
...
```

#### REQ-BRUTE-003: Delay Expiration

Failed request entries SHOULD be cleaned up after a period of inactivity.

| Parameter | Value | Requirement ID |
|-----------|-------|----------------|
| Expiration age | 60 seconds after last delay (`FAIL_AGE`) | REQ-BRUTE-003a |
| Cleanup mechanism | One-shot setTimeout after 30 seconds | REQ-BRUTE-003b |

**Implementation Note:** The current implementation uses a single `setTimeout(30000)` call at module initialization to clean up entries older than `FAIL_AGE` (60 seconds). This is a one-shot cleanup, not a recurring interval. Entries created after the cleanup runs may persist until server restart. This is a known limitation.

**Reference:** `lib/authorization/delaylist.js:45-53`

#### REQ-BRUTE-004: Successful Authentication Clears Delay

A successful authentication MUST immediately clear the delay for that IP.

#### REQ-BRUTE-005: Failed Authentication Notification

Failed authentication attempts MUST trigger an admin notification.

**Notification Content:**
- Title: "Failed authentication"
- Message: IP address and warning about potential misconfiguration

---

## 6. Subject Management Requirements

### 6.1 Subject CRUD Operations

#### REQ-SUBJ-001: Subject Creation

Subjects MUST be creatable via the admin API.

**Required Fields:**
| Field | Type | Description | Requirement ID |
|-------|------|-------------|----------------|
| `name` | String | Display name for the subject | REQ-SUBJ-001a |
| `roles` | Array | List of role names assigned | REQ-SUBJ-001b |

**Auto-generated Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectID | Unique identifier |
| `created_at` | ISO 8601 | Creation timestamp |
| `accessToken` | String | Generated access token |
| `digest` | String | Token digest for matching |

#### REQ-SUBJ-002: Subject Modification

Subjects MUST be modifiable via the admin API.

#### REQ-SUBJ-003: Subject Deletion

Subjects MUST be deletable via the admin API.

**Behavior:** Once a subject is deleted, its access token becomes unusable because the subject lookup will fail. There is no explicit token revocation mechanism; invalidation occurs because the subject record no longer exists in the database.

**Note:** Existing JWTs containing the deleted subject's access token will fail on the next permission resolution when the subject cannot be found.

### 6.2 Role Management

#### REQ-ROLE-001: Role Creation

Custom roles MUST be creatable via the admin API.

**Required Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Unique role name |
| `permissions` | Array | List of Shiro-format permissions |

#### REQ-ROLE-002: Built-in Role Behavior

Built-in roles (admin, denied, readable, etc.) are defined in code and merged with database roles at runtime.

**Note:** The current implementation does not explicitly protect built-in roles from deletion attempts via the admin API. Deleting a built-in role from the database has no effect since the role is re-added from `storage.defaultRoles` on reload. This behavior is implementation-specific and may change.

---

## 7. Socket.IO Authentication Requirements

### 7.1 Storage Namespace

#### REQ-SOCK-001: Subscription Authentication

The `/storage` WebSocket namespace MUST require authentication for data subscriptions.

**Message Format:**
```javascript
socket.emit('subscribe', {
  accessToken: 'subject-access-token',
  collections: ['entries', 'treatments']
});
```

#### REQ-SOCK-002: Per-Collection Authorization

Access to collections via WebSocket MUST respect the subject's permissions.

| Permission | Required For |
|------------|--------------|
| `api:entries:read` | Subscribe to entries |
| `api:treatments:read` | Subscribe to treatments |
| `api:treatments:create` | dbAdd to treatments |

### 7.2 Alarm Namespace

#### REQ-SOCK-010: Alarm Subscription

The `/alarm` namespace MUST require a valid access token for subscription.

---

## 8. Error Handling Requirements

### 8.1 Authentication Errors

#### REQ-ERR-001: Unauthorized Response

Invalid authentication MUST return HTTP 401 Unauthorized.

**Response Format:**
```json
{
  "status": 401,
  "message": "Unauthorized"
}
```

#### REQ-ERR-002: Forbidden Response

Valid authentication with insufficient permissions MUST return HTTP 403 Forbidden.

---

## 9. Traceability Matrix

| Requirement | Test File | Test Case | Status |
|-------------|-----------|-----------|--------|
| REQ-AUTH-001a | `security.test.js` | "should work fine set" | Covered |
| REQ-AUTH-001b | `security.test.js` | "should not work short" | Covered |
| REQ-AUTH-002a | `security.test.js` | "should work fine set" | Covered |
| REQ-AUTH-003a | `verifyauth.test.js` | SHA-1 verification | Covered |
| REQ-AUTH-003b | `verifyauth.test.js` | SHA-512 verification | Covered |
| REQ-AUTH-011a | `api.security.test.js` | "Data load should succeed with token in place of a secret" | Covered |
| REQ-AUTH-011b | `api.security.test.js` | "Data load should succeed with GET token" | Covered |
| REQ-AUTH-020a | `api.security.test.js` | "Should return a JWT on token" | Covered |
| REQ-AUTH-024a | `api.security.test.js` | "Data load should succeed with a bearer token" | Covered |
| REQ-AUTH-024c | `api.security.test.js` | "Data load fail succeed with a false bearer token" | Covered |
| REQ-AUTHZ-003b | `api.security.test.js` | "Data load should fail unauthenticated" | Covered |
| REQ-BRUTE-002 | `verifyauth.test.js` | "should fail unauthorized and delay subsequent attempts" | Covered |
| REQ-BRUTE-004 | Implicit in `verifyauth.test.js` | Successful auth clears delay | Implicit |
| REQ-SOCK-001 | N/A | WebSocket subscription auth | Not Covered |
| REQ-SOCK-002 | N/A | Per-collection authorization | Not Covered |
| REQ-SUBJ-001 | N/A | Subject creation | Not Covered |
| REQ-ROLE-001 | N/A | Role creation | Not Covered |

---

## 10. Coverage Gaps and Recommendations

### 10.1 Identified Gaps

| Gap | Priority | Recommendation |
|-----|----------|----------------|
| WebSocket authentication testing | High | Add tests for `/storage` and `/alarm` subscription auth |
| Subject/Role CRUD testing | Medium | Add API tests for admin tools endpoints |
| JWT expiration testing | Medium | Add test for expired JWT rejection |
| Permission wildcard testing | Low | Add comprehensive Shiro pattern tests |

### 10.2 Future Enhancements

| Enhancement | Description | Priority |
|-------------|-------------|----------|
| Token expiration | Add expiration to access tokens | Medium |
| Refresh tokens | Add JWT refresh mechanism | Low |
| Audit logging | Log all auth events for compliance | Medium |
| **OIDC Actor Identity** | External identity provider integration with verified actor tracking | **High** |

#### OIDC Actor Identity Proposal

A comprehensive RFC has been created for integrating OpenID Connect and OAuth 2.0 identity management into Nightscout Core. This enables:

- **Verified actor tracking** - Replace freeform `enteredBy` with cryptographically-verified identities
- **Care coordination** - Know exactly who performed each action (Mom, Dad, school nurse)
- **Delegation support** - Track when actions are performed on behalf of others
- **Audit trails** - HIPAA-grade compliance for clinical settings
- **Automation safety** - Distinguish human decisions from automated actions (Loop, OpenAPS)

See [OIDC Actor Identity Proposal](../proposals/oidc-actor-identity-proposal.md) for:
- Full architecture and protocol flows
- JWT claims specification
- Actor lookup collection schema
- Migration path for `enteredBy`
- Test plan and implementation readiness

---

## 11. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Nightscout Team | Initial specification |

---

## 12. References

- [Security Audit](../audits/security-audit.md) - Security analysis and recommendations
- [API Layer Audit](../audits/api-layer-audit.md) - API endpoint inventory
- [Modernization Roadmap](../meta/modernization-roadmap.md) - OIDC/OAuth2 plans
- `lib/authorization/` - Implementation source code
