# Authorization and Security Test Specification

**Document Version:** 1.1  
**Last Updated:** January 2026  
**Status:** Active  
**Related Requirements:** [Authorization Security Requirements](../requirements/authorization-security-requirements.md)

---

## Progress & Coverage Status

### Current State

| Metric | Value |
|--------|-------|
| Total Tests | 21 |
| Coverage Status | Core paths covered, gaps in WebSocket/API v3 |
| Last Test Run | January 2026 |
| Known Regressions | None |

### Recent Discoveries

| Date | Discovery | Impact | Source |
|------|-----------|--------|--------|
| 2026-01-15 | JWT uses dedicated signing key, not API_SECRET | Corrected security model understanding | `lib/server/enclave.js` |
| 2026-01-15 | Brute-force cleanup is one-shot setTimeout | Potential long-running server issue | `lib/authorization/delaylist.js` |
| 2026-01-15 | Both SHA-1 and SHA-512 accepted for API_SECRET | Migration path but potential confusion | `lib/hashauth.js` |
| 2026-01-15 | Access token = SHA-1(apiKeySHA1 + subject._id) | Not direct API_SECRET derivative | `lib/server/enclave.js:getSubjectHash()` |

### Priority Gaps Summary

| Gap | Priority | Status |
|-----|----------|--------|
| WebSocket Auth (`/storage` subscription) | High | Not Covered |
| JWT Expiration rejection | High | Not Covered |
| Permission Wildcards (Shiro patterns) | High | Not Covered |
| API v3 Security model | High | Separate spec needed |
| Subject CRUD operations | Medium | Not Covered |
| Role Management | Medium | Not Covered |
| Audit Events | Low | Not Covered |

### Test Execution

```bash
npm test -- --grep "API_SECRET\|Security\|hashauth\|verifyauth"
npm test -- --grep "Security of REST API V1"
```

---

## 1. Purpose

This document specifies the test cases for validating authentication and authorization behavior across Nightscout's API, WebSocket, and client-side layers. Each test case is linked to a formal requirement and mapped to actual test implementations.

---

## 2. Test Suite Overview

### 2.1 Test Files

| File | Purpose | Test Count |
|------|---------|------------|
| `tests/security.test.js` | API_SECRET validation and basic auth | 3 |
| `tests/hashauth.test.js` | Client-side hash authentication | 4 |
| `tests/verifyauth.test.js` | Auth verification endpoint and brute-force delay | 4 |
| `tests/api.security.test.js` | JWT, Bearer tokens, role-based access | 10 |
| **Total** | | **21** |

### 2.2 Test Execution

```bash
# Run all security/auth tests
npm test -- --grep "API_SECRET\|Security\|hashauth\|verifyauth"

# Run specific suite
npm test -- --grep "API_SECRET"
npm test -- --grep "Security of REST API V1"
npm test -- --grep "hashauth"
npm test -- --grep "verifyauth"
```

---

## 3. API_SECRET Test Cases

### 3.1 Security Test Suite (`tests/security.test.js`)

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| SEC-001 | Should fail when unauthorized | REQ-ERR-001 | 401 Unauthorized |
| SEC-002 | Should work fine set | REQ-AUTH-001a, REQ-AUTH-004 | 200 OK (valid hash grants admin) |
| SEC-003 | Should not work short | REQ-AUTH-001b | API_SECRET null, error logged |

#### Test Case Details

**SEC-001: Should fail when unauthorized**
```javascript
it('should fail when unauthorized', function(done) {
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  delete process.env.API_SECRET;
  process.env.API_SECRET = 'this is my long pass phrase';
  var env = require('../lib/server/env')();
  
  env.enclave.isApiKey(known).should.equal(true);
  
  setup_app(env, function(ctx) {
    ctx.app.enabled('api').should.equal(true);
    ctx.app.api_secret = '';
    ping_authorized_endpoint(ctx.app, 401, done);
  });
});
```

**SEC-002: Should work fine set**
```javascript
it('should work fine set', function(done) {
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  delete process.env.API_SECRET;
  process.env.API_SECRET = 'this is my long pass phrase';
  var env = require('../lib/server/env')();
  
  env.enclave.isApiKey(known).should.equal(true);
  
  setup_app(env, function(ctx) {
    ctx.app.enabled('api').should.equal(true);
    ctx.app.api_secret = known;
    ping_authorized_endpoint(ctx.app, 200, done);
  });
});
```

**SEC-003: Should not work short**
```javascript
it('should not work short', function() {
  delete process.env.API_SECRET;
  process.env.API_SECRET = 'tooshort';
  var env = require('../lib/server/env')();
  
  should.not.exist(env.api_secret);
  env.err[0].desc.should.startWith('API_SECRET should be at least');
});
```

---

## 4. Client-Side Hash Authentication Test Cases

### 4.1 Hashauth Test Suite (`tests/hashauth.test.js`)

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| HASH-001 | Should make module unauthorized | N/A (UI state) | Status shows "Unauthorized" |
| HASH-002 | Should make module authorized | N/A (UI state) | Status shows "Admin authorized" |
| HASH-003 | Should store hash and remove authentication | REQ-AUTH-002a (client-side) | Hash matches expected SHA-1 |
| HASH-004 | Should not store hash | REQ-AUTH-002a (client-side) | Hash computed but not persisted |
| HASH-005 | Should report secret too short | REQ-AUTH-001b (client validation) | Alert shows "Too short API secret" |

**Note:** These tests validate client-side hash computation and UI state management, not server-side authentication. They verify that the client correctly hashes the API_SECRET before transmission.

#### Test Case Details

**HASH-003: Should store hash and then remove authentication**
```javascript
it('should store hash and the remove authentication', function () {
  var client = require('../lib/client');
  var hashauth = require('../lib/client/hashauth');
  var localStorage = require('./fixtures/localstorage');   
  
  localStorage.remove('apisecrethash');
  
  hashauth.init(client,$);
  hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
    hashauth.authenticated = true;
    next(true); 
  };
  hashauth.updateSocketAuth = function mockUpdateSocketAuth() {};

  client.init();

  hashauth.processSecret('this is my long pass phrase', true);
  
  hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
  localStorage.get('apisecrethash').should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
  hashauth.isAuthenticated().should.equal(true);
  
  hashauth.removeAuthentication();
  hashauth.isAuthenticated().should.equal(false);
});
```

#### Known Testing Quirks

**Browser Environment Simulation:**
- Tests use `benv` package to simulate browser DOM
- `headless.js` fixture provides secure jsdom harness
- Tests mock `localStorage`, `window.alert`, and jQuery plugins

**Network Isolation:**
- `mockAjax: true` prevents actual network requests
- `verifyAuthentication` is mocked to control auth state

---

## 5. Verification Endpoint Test Cases

### 5.1 Verifyauth Test Suite (`tests/verifyauth.test.js`)

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| VERIFY-001 | Should return defaults when called without secret | REQ-AUTHZ-003 | 200 OK with default permissions |
| VERIFY-002 | Should fail when calling with wrong secret | REQ-ERR-001 | Message: "UNAUTHORIZED" |
| VERIFY-003 | Should fail unauthorized and delay subsequent attempts | REQ-BRUTE-002 | Progressive delay > 49ms |
| VERIFY-004 | Should work fine authorized | REQ-AUTH-002a | 200 OK |

#### Test Case Details

**VERIFY-003: Should fail unauthorized and delay subsequent attempts**
```javascript
it('should fail unauthorized and delay subsequent attempts', function (done) {
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  delete process.env.API_SECRET;
  process.env.API_SECRET = 'this is my long pass phrase';
  var env = require('../lib/server/env')();
  
  env.enclave.isApiKey(known).should.equal(true);
  
  setup_app(env, function (ctx) {
    ctx.app.enabled('api').should.equal(true);
    ctx.app.api_secret = 'wrong secret';
    const time = Date.now();

    function checkTimer(res) {
      res.body.message.message.should.equal('UNAUTHORIZED');
      const delta = Date.now() - time;
      delta.should.be.greaterThan(49);
      done();
    }

    function pingAgain (res) {
      res.body.message.message.should.equal('UNAUTHORIZED');
      ping_authorized_endpoint(ctx.app, 200, checkTimer, true);
    }

    ping_authorized_endpoint(ctx.app, 200, pingAgain, true);
  });
});
```

#### Brute-Force Protection Verification

This test validates the cumulative delay behavior:
1. First failed attempt records the IP
2. Second failed attempt experiences delay
3. Total time between first and third request should exceed configured delay

**Configuration Note:** Tests use `settings.authFailDelay` which can be configured for faster test execution while maintaining realistic behavior in production.

---

## 6. REST API Security Test Cases

### 6.1 API Security Test Suite (`tests/api.security.test.js`)

| Test ID | Test Case | Requirement | Expected Result |
|---------|-----------|-------------|-----------------|
| APISEC-001 | Should fail on false token | REQ-ERR-001 | 401 Unauthorized |
| APISEC-002 | Data load should fail unauthenticated | REQ-AUTHZ-003b | 401 Unauthorized |
| APISEC-003 | Should return a JWT on token | REQ-AUTH-020a | Valid JWT with iat, exp |
| APISEC-004 | Should return JWT with default roles on broken role token | REQ-AUTHZ-003c | JWT issued with default roles |
| APISEC-005 | Data load should succeed with API SECRET | REQ-AUTH-002a | 200 OK |
| APISEC-006 | Data load should succeed with GET token | REQ-AUTH-011b | 200 OK |
| APISEC-007 | Data load should succeed with token in place of a secret | REQ-AUTH-011a | 200 OK |
| APISEC-008 | Data load should succeed with a bearer token | REQ-AUTH-024a | 200 OK |
| APISEC-009 | Data load fail with a false bearer token | REQ-AUTH-024c | 401 Unauthorized |
| APISEC-010 | /verifyauth should return OK for Bearer tokens | REQ-AUTH-024a | message: "OK", isAdmin: true |

#### Test Case Details

**APISEC-003: Should return a JWT on token**
```javascript
it('Should return a JWT on token', function(done) {
  const now = Math.round(Date.now() / 1000) - 1;
  request(self.app)
    .get('/api/v2/authorization/request/' + self.token.read)
    .expect(200)
    .end(function(err, res) {
      const decodedToken = jwt.decode(res.body.token);
      decodedToken.accessToken.should.equal(self.token.read);
      decodedToken.iat.should.be.aboveOrEqual(now);
      decodedToken.exp.should.be.above(decodedToken.iat);
      done();
    });
});
```

**APISEC-008: Data load should succeed with a bearer token**
```javascript
it('Data load should succeed with a bearer token', function(done) {
  request(self.app)
    .get('/api/v2/authorization/request/' + self.token.read)
    .expect(200)
    .end(function(err, res) {
      const token = res.body.token;
      request(self.app)
        .get('/api/v1/entries.json')
        .set('Authorization', 'Bearer ' + token)
        .expect(200)
        .end(function(err, res) {
          done();
        });
    });
});
```

#### Test Setup Notes

**authSubject Fixture:**
The `tests/fixtures/api3/authSubject.js` fixture creates test subjects with various permission levels:
- `read` - Read-only access
- `noneSubject` - No specific roles (tests default role behavior)
- `adminAll` - Full admin access

**Environment Configuration:**
```javascript
self.env.settings.authDefaultRoles = 'denied';
```
Tests explicitly set `denied` as default to ensure unauthenticated access is blocked.

---

## 7. Test Environment Setup

### 7.1 Prerequisites

```javascript
before(function(done) {
  var api = require('../lib/api/');
  delete process.env.API_SECRET;
  process.env.API_SECRET = 'this is my long pass phrase';
  self.env = require('../lib/server/env')();
  self.env.settings.authDefaultRoles = 'denied';
  
  require('../lib/server/bootevent')(self.env, language).boot(async function booted (ctx) {
    self.app.use('/api/v1', api(self.env, ctx));
    self.app.use('/api/v2/authorization', ctx.authorization.endpoints);
    
    let authResult = await authSubject(ctx.authorization.storage);
    self.subject = authResult.subject;
    self.token = authResult.accessToken;
    
    done();
  });
});
```

### 7.2 Common Test Patterns

**API_SECRET Hash:**
```javascript
var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
// SHA-1 hash of 'this is my long pass phrase'
```

**SHA-512 Hash (also accepted):**
```javascript
var known512 = '8c8743d38cbe00debe4b3ba8d0ffbb85e4716c982a61bb9e57bab203178e3718b2965831c1a5e42b9da16f082fdf8a6cecf993b49ed67e3a8b1cd475885d8070';
```

---

## 8. Coverage Matrix

| Requirement | Test ID(s) | Status |
|-------------|------------|--------|
| REQ-AUTH-001a | SEC-002 | Covered |
| REQ-AUTH-001b | SEC-003, HASH-005 | Covered |
| REQ-AUTH-002a | VERIFY-004, APISEC-005, HASH-003 (client) | Covered |
| REQ-AUTH-003a | VERIFY-001 (implicit) | Covered |
| REQ-AUTH-003b | VERIFY-001 | Covered |
| REQ-AUTH-004 | SEC-002 | Covered |
| REQ-AUTH-011a | APISEC-007 | Covered |
| REQ-AUTH-011b | APISEC-006 | Covered |
| REQ-AUTH-020a | APISEC-003 | Covered |
| REQ-AUTH-024a | APISEC-008, APISEC-010 | Covered |
| REQ-AUTH-024c | APISEC-009 | Covered |
| REQ-AUTHZ-001 | N/A | Not Covered |
| REQ-AUTHZ-003b | APISEC-002 | Covered |
| REQ-AUTHZ-010 | N/A | Not Covered |
| REQ-AUTHZ-011 | N/A | Not Covered |
| REQ-BRUTE-002 | VERIFY-003 | Covered |
| REQ-BRUTE-004 | Implicit in VERIFY-004 | Implicit |
| REQ-ERR-001 | SEC-001, APISEC-001, APISEC-009 | Covered |
| REQ-SOCK-001 | N/A | Not Covered |
| REQ-SOCK-002 | N/A | Not Covered |
| REQ-SUBJ-001 | N/A | Not Covered |
| REQ-ROLE-001 | N/A | Not Covered |

**Note:** API v3 security tests (`tests/api3.security.test.js`) are out of scope for this document. They cover the distinct API v3 authentication model.

---

## 9. Coverage Gaps

### 9.1 High Priority Gaps

| Gap | Description | Recommended Test |
|-----|-------------|------------------|
| WebSocket Auth | No tests for `/storage` subscription authentication | Add socket.io-client tests for subscribe with/without token |
| JWT Expiration | No test for expired JWT rejection | Create JWT with past exp, verify 401 |
| Permission Wildcards | Shiro pattern matching not explicitly tested | Test `api:*:read` vs `api:entries:read` |
| API v3 Security | API v3 has distinct security model (`lib/api3/security.js`) | Review `tests/api3.*.test.js` for security coverage, document separately |

### 9.2 Medium Priority Gaps

| Gap | Description | Recommended Test |
|-----|-------------|------------------|
| Subject CRUD | No tests for subject creation/update/delete | Add API tests for admin endpoints |
| Role Management | Custom role creation not tested | Test role creation and permission assignment |
| Default Roles | Built-in roles not verified | Test each default role's permission set |

### 9.3 Low Priority Gaps

| Gap | Description | Recommended Test |
|-----|-------------|------------------|
| Audit Events | Failed auth notification not verified | Mock bus, verify admin-notify event |
| Delay Cleanup | Automatic delay list cleanup not tested | Fast-forward time, verify cleanup |

---

## 10. Discovered Quirks and Barriers

### 10.1 Client-Side Testing Complexity

**Issue:** The `hashauth.test.js` tests require complex browser environment simulation using `benv`.

**Details:**
- Tests rely on `headless.js` fixture for secure jsdom setup
- Network isolation via `NoNetworkLoader` pattern prevents accidental external requests
- `js-storage` module caches environment detection on first require, requiring cache clearing in `after()` hook

**Barrier:** Modernizing these tests requires maintaining the secure jsdom harness to prevent test network leakage.

### 10.2 Brute-Force Test Timing

**Issue:** Brute-force delay tests have timing sensitivity.

**Details:**
- Default delay is 5000ms per failure
- Tests use lower `authFailDelay` setting for faster execution
- Test timeout must exceed cumulative delay

**Quirk:** The test verifies delay > 49ms which is a very loose bound. Production uses 5000ms default.

### 10.3 SHA-1 vs SHA-512 Acceptance

**Issue:** Both SHA-1 and SHA-512 hashes are accepted for API_SECRET.

**Details:**
- SHA-1 produces 40 character hex string
- SHA-512 produces 128 character hex string
- Both are validated in `verifyauth.test.js`

**Note:** This dual-hash support provides migration path but may be confusing.

### 10.4 Delay List Cleanup Limitation

**Issue:** The brute-force delay list cleanup is a one-shot mechanism, not recurring.

**Details:**
- `delaylist.js` uses a single `setTimeout(30000)` at module initialization
- Entries created after the cleanup runs may persist until server restart
- The 60-second `FAIL_AGE` is only checked during that single cleanup

**Impact:** Long-running servers may accumulate stale delay list entries. This is low-risk since successful authentication clears entries and entries naturally expire when their delay time passes.

### 10.5 API v3 Security Model Scope

**Issue:** API v3 has a distinct security implementation that is not covered by this specification.

**Details:**
- `lib/api3/security.js` implements API v3-specific authentication
- Tests in `tests/api3.*.test.js` cover API v3 behavior
- This document focuses on the core `lib/authorization/` module used by API v1/v2

**Recommendation:** Create separate API v3 security specification if detailed documentation is needed.

---

## 11. Test Modernization Notes

### 11.1 Alignment with Testing Modernization Proposal

Per `docs/proposals/testing-modernization-proposal.md`:

**Track 1 (Testing Foundation):**
- Security tests are identified as "keep" tests due to their critical nature
- hashauth tests require the secure jsdom harness from Track 1

**Track 2 (Logic/DOM Separation):**
- `hashauth.js` client module could be split into pure logic (hash computation) and DOM interaction
- Pure logic portion could be tested without browser simulation

### 11.2 Recommended Test Improvements

1. **Add explicit JWT expiration test** - Create expired JWT, verify rejection
2. **Add WebSocket auth tests** - Use socket.io-client in test environment
3. **Parameterize delay tests** - Test with configurable `authFailDelay`
4. **Add Shiro pattern tests** - Explicit wildcard matching verification

---

## 12. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 2026 | Nightscout Team | Initial specification |

---

## 13. References

- [Authorization Security Requirements](../requirements/authorization-security-requirements.md)
- [Security Audit](../audits/security-audit.md)
- [Testing Modernization Proposal](../proposals/testing-modernization-proposal.md)
- Test files in `tests/` directory
