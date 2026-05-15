# RFC: OpenID Connect Actor Identity Plugin for Nightscout Core

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Authors:** NRG Team  
**Target Audience:** Nightscout Core Maintainers, Community Contributors  
**Source:** [nightscout-roles-gateway proposal](https://github.com/t1pal/nightscout-roles-gateway/blob/replit/docs/proposals/oidc-actor-identity-proposal.md)

---

## Abstract

This proposal outlines a minimal protocol for integrating OpenID Connect (OIDC) and OAuth 2.0 identity management into Nightscout Core, enabling structured actor tracking for all data modifications. The goal is to replace the current freeform `enteredBy` field with cryptographically-verified actor identities, allowing Nightscout to definitively answer: "Was this action performed by Mom, Dad, the school nurse, or an automated agent?"

---

## Table of Contents

1. [Background & Motivation](#1-background--motivation)
2. [Current State Assessment](#2-current-state-assessment)
3. [Proposed Architecture](#3-proposed-architecture)
4. [OAuth2/OIDC Protocol Flow](#4-oauth2oidc-protocol-flow)
5. [JWT Claims Specification](#5-jwt-claims-specification)
6. [Actor Lookup Collection Schema](#6-actor-lookup-collection-schema)
7. [Nightscout Core Plugin Requirements](#7-nightscout-core-plugin-requirements)
8. [Migration Path for enteredBy](#8-migration-path-for-enteredby)
9. [Implementation Readiness](#9-implementation-readiness)
10. [Test Plan](#10-test-plan)
11. [Interview Questions for NS Authors](#11-interview-questions-for-ns-authors)
12. [Open Questions](#12-open-questions)
13. [Appendix: Example Flows](#13-appendix-example-flows)

---

## 1. Background & Motivation

### The Problem with `enteredBy`

Currently, Nightscout tracks who performed an action via the `enteredBy` field, which is:
- **Freeform text** - No validation or structure
- **Self-reported** - Clients set their own value
- **Unauthenticated** - No cryptographic proof of identity
- **Inconsistent** - "Mom", "mom", "Mother", "Parent1" may all be the same person

### Why This Matters

For diabetes management, especially in pediatric care, knowing exactly who performed an action is critical:
- **Care coordination** - Did the school nurse already give insulin?
- **Accountability** - Which parent acknowledged the alert?
- **Audit trails** - Regulatory compliance for clinical settings
- **Automation safety** - Distinguishing human decisions from automated actions

### The Solution

An OIDC-integrated identity system where:
1. Nightscout instances are provisioned as OAuth2 clients
2. Users authenticate through a trusted Identity Provider (IdP)
3. Actions are tagged with verified actor claims in JWTs
4. An actor lookup collection provides human-readable context

### Features Unlocked by Verified Identity

| Feature | Description | Enabled By |
|---------|-------------|------------|
| Care Team Visibility | See which caregiver made each decision | Actor claims |
| Delegation Tracking | Know when actions are performed on behalf of others | `act` claim |
| Automation Audit | Distinguish Loop decisions from manual overrides | `actor_type` |
| School/Clinic Access | Time-limited, auditable access for institutions | Token scopes |
| Alert Accountability | Track who acknowledged which alerts | Actor reference |
| Regulatory Compliance | HIPAA-grade audit trails | Full identity chain |

---

## 2. Current State Assessment

### Already Implemented in NRG Gateway

| Component | Status | Location |
|-----------|--------|----------|
| OAuth2 client credentials storage | ✅ Implemented | `oauth2_credentials` table |
| Hydra client lifecycle (create/delete) | ✅ Implemented | `lib/clients/index.js` |
| Kratos session resolution | ✅ Implemented | `lib/privy/index.js` |
| NSJWT token exchange | ✅ Implemented | `lib/exchanged.js` |
| Token caching (8hr TTL) | ✅ Implemented | Keyv/Redis |
| ACL-to-identity mapping | ✅ Implemented | `lib/policies/index.js` |
| X-NSJWT header injection | ✅ Implemented | `lib/exchanged.js` |

### What Needs to Be Built

| Component | Owner | Description | Priority |
|-----------|-------|-------------|----------|
| OIDC discovery endpoint proxy | NRG Gateway | Forward `.well-known` to Hydra | High |
| Actor claims in JWT payload | NRG Gateway | Extend NSJWT with actor metadata | High |
| Nightscout OIDC plugin | NS Core | Handle redirects, extract claims | High |
| Actor lookup collection | NS Core | MongoDB collection for actor records | Medium |
| enteredBy migration | NS Core | Backfill and forward-compatibility | Medium |

### Relationship to Existing Auth System

The OIDC plugin complements (does not replace) the existing authentication:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Authentication Methods                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ API_SECRET  │  │ Access      │  │ OIDC/OAuth2 │ ← NEW        │
│  │ (admin)     │  │ Tokens      │  │ (verified   │              │
│  │             │  │ (subjects)  │  │  identity)  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│         │               │               │                        │
│         └───────────────┼───────────────┘                        │
│                         ▼                                        │
│              ┌─────────────────────┐                             │
│              │  Shiro Permission   │                             │
│              │  System             │                             │
│              │  (api:*:read, etc)  │                             │
│              └─────────────────────┘                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Actor Identity Architecture                          │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │         User's Browser/App           │
                    └──────────────────────────────────────┘
                                      │
                                      │ 1. Access NS site
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Nightscout Instance                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  OIDC Plugin (NEW)                                                   │    │
│  │  - Detects unauthenticated request to protected resource            │    │
│  │  - Redirects to IdP authorize URL                                   │    │
│  │  - Exchanges callback code for tokens                               │    │
│  │  - Extracts actor claims from JWT                                   │    │
│  │  - Stores actor reference on data mutations                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      │ Actor claims extracted                │
│                                      ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Existing Collections            │  Actor Lookup Collection (NEW)   │    │
│  │  ┌───────────────┐               │  ┌───────────────────────────┐   │    │
│  │  │ treatments    │               │  │ actors                    │   │    │
│  │  │ - actor_ref ──┼───────────────┼─▶│ - _id (sub claim)        │   │    │
│  │  │ - enteredBy   │               │  │ - display_name           │   │    │
│  │  │   (deprecated)│               │  │ - actor_type             │   │    │
│  │  └───────────────┘               │  │ - delegation_info        │   │    │
│  │  ┌───────────────┐               │  │ - last_seen              │   │    │
│  │  │ entries       │               │  └───────────────────────────┘   │    │
│  │  └───────────────┘               │                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ 2. Redirect to IdP
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NRG Gateway (Identity Provider)                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────────┐     │
│  │  OIDC Endpoints │    │  Warden Gateway │    │  Token Service       │     │
│  │                 │    │                 │    │                      │     │
│  │  /.well-known/  │    │  /warden/v1/*   │    │  JWT with actor      │     │
│  │  /oauth2/*      │    │                 │    │  claims              │     │
│  └────────┬────────┘    └─────────────────┘    └──────────────────────┘     │
│           │                                                                  │
│           │ Proxy                                                            │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Load Balancer                                     │    │
│  │                         │                                            │    │
│  │         ┌───────────────┼───────────────┐                           │    │
│  │         ▼               ▼               ▼                           │    │
│  │  ┌───────────┐   ┌───────────┐   ┌───────────┐                     │    │
│  │  │   Hydra   │   │  Kratos   │   │    NRG    │                     │    │
│  │  │  OAuth2   │   │ Identity  │   │  Warden   │                     │    │
│  │  └───────────┘   └───────────┘   └───────────┘                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. OAuth2/OIDC Protocol Flow

### 4.1 Client Provisioning (One-time Setup)

When a Nightscout site is registered with NRG, OAuth2 credentials are automatically provisioned:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Site      │     │     NRG     │     │    Hydra    │
│   Owner     │     │   Gateway   │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  1. Register site │                   │
       │ ─────────────────▶│                   │
       │                   │                   │
       │                   │  2. Create client │
       │                   │ ─────────────────▶│
       │                   │                   │
       │                   │  3. client_id +   │
       │                   │     client_secret │
       │                   │ ◀─────────────────│
       │                   │                   │
       │  4. Credentials   │                   │
       │     stored in NS  │                   │
       │     config        │                   │
       │ ◀─────────────────│                   │
```

**NS Instance Configuration:**
```javascript
{
  "oidc": {
    "issuer": "https://nrg.example.com",
    "client_id": "ns-site-abc123",
    "client_secret": "${NS_OIDC_CLIENT_SECRET}",
    "redirect_uri": "https://my-ns-site.example.com/oidc/callback",
    "scopes": ["openid", "profile", "nightscout:actor"]
  }
}
```

### 4.2 User Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │ Nightscout  │     │     NRG     │     │   Kratos    │
│  (Parent)   │     │  Instance   │     │   Gateway   │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │                   │
       │  1. GET /careportal                   │                   │
       │ ─────────────────▶│                   │                   │
       │                   │                   │                   │
       │                   │  (No valid session)                   │
       │                   │                   │                   │
       │  2. 302 Redirect to IdP               │                   │
       │ ◀─────────────────│                   │                   │
       │                   │                   │                   │
       │  3. GET /oauth2/authorize             │                   │
       │ ─────────────────────────────────────▶│                   │
       │                   │                   │                   │
       │                   │                   │  4. Check session │
       │                   │                   │ ─────────────────▶│
       │                   │                   │                   │
       │                   │                   │  5. Session valid │
       │                   │                   │     + identity    │
       │                   │                   │ ◀─────────────────│
       │                   │                   │                   │
       │  6. 302 Redirect with code            │                   │
       │ ◀─────────────────────────────────────│                   │
       │                   │                   │                   │
       │  7. GET /oidc/callback?code=xxx       │                   │
       │ ─────────────────▶│                   │                   │
       │                   │                   │                   │
       │                   │  8. POST /oauth2/token                │
       │                   │ ─────────────────▶│                   │
       │                   │                   │                   │
       │                   │  9. id_token + access_token           │
       │                   │     (with actor claims)               │
       │                   │ ◀─────────────────│                   │
       │                   │                   │                   │
       │  10. Session established              │                   │
       │      (actor context available)        │                   │
       │ ◀─────────────────│                   │                   │
```

### 4.3 Authorization Code Request

**GET /oauth2/authorize**
```
GET https://nrg.example.com/oauth2/authorize?
  response_type=code&
  client_id=ns-site-abc123&
  redirect_uri=https://my-ns-site.example.com/oidc/callback&
  scope=openid%20profile%20nightscout:actor&
  state={random_state}&
  nonce={random_nonce}
```

### 4.4 Token Exchange

**POST /oauth2/token**
```
POST https://nrg.example.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code={authorization_code}&
redirect_uri=https://my-ns-site.example.com/oidc/callback&
client_id=ns-site-abc123&
client_secret={client_secret}
```

---

## 5. JWT Claims Specification

### 5.1 Standard OIDC Claims

| Claim | Type | Description | Example |
|-------|------|-------------|---------|
| `iss` | string | Issuer URL | `https://nrg.example.com` |
| `sub` | string | Subject identifier (stable, unique) | `kratos-user-uuid` |
| `aud` | string | Audience (NS client_id) | `ns-site-abc123` |
| `exp` | number | Expiration timestamp | `1705003600` |
| `iat` | number | Issued at timestamp | `1705000000` |
| `nonce` | string | Replay protection | `abc123xyz` |

### 5.2 Nightscout Actor Claims

| Claim | Type | Description | Example |
|-------|------|-------------|---------|
| `ns:actor_type` | string | Type of actor | `human`, `agent`, `controller` |
| `ns:display_name` | string | Human-readable name | `"Mom"`, `"School Nurse"` |
| `ns:actor_ref` | string | Reference to actor collection | `actor-uuid-123` |
| `ns:permissions` | array | Granted Shiro permissions | `["api:treatments:create"]` |

### 5.3 Delegation Claims (RFC 8693)

When acting on behalf of another (e.g., clinic acting for patient):

| Claim | Type | Description | Example |
|-------|------|-------------|---------|
| `act` | object | Actor who is acting | See below |
| `act.sub` | string | Acting party subject | `clinic-staff-uuid` |
| `act.ns:display_name` | string | Acting party name | `"Dr. Smith"` |
| `may_act` | object | Who may act on subject's behalf | Delegation rules |

**Example Delegated Token:**
```json
{
  "iss": "https://nrg.example.com",
  "sub": "patient-uuid-456",
  "ns:display_name": "Patient Jane",
  "ns:actor_type": "human",
  "act": {
    "sub": "clinic-staff-uuid",
    "ns:display_name": "Dr. Smith",
    "ns:actor_type": "human"
  },
  "ns:permissions": ["api:treatments:create", "api:entries:read"]
}
```

### 5.4 Actor Type Hierarchy

Following the Control Plane RFC authority model:

```
human > agent > controller

Where:
- human: Real person authenticated via IdP
- agent: Automated system acting with delegated authority (e.g., Loop)
- controller: Low-level device or service
```

---

## 6. Actor Lookup Collection Schema

### 6.1 Collection: `actors`

```javascript
{
  "_id": "kratos-user-uuid",           // Same as JWT `sub` claim
  "display_name": "Mom",               // Configurable by user
  "actor_type": "human",               // human | agent | controller
  "email": "mom@example.com",          // Optional, from OIDC profile
  "created_at": "2026-01-15T10:00:00Z",
  "last_seen": "2026-01-15T14:30:00Z",
  "metadata": {
    "idp_issuer": "https://nrg.example.com",
    "preferred_username": "mom_jane"
  },
  "delegation": {
    "can_delegate_to": ["agent-loop-uuid"],
    "delegated_from": null
  }
}
```

### 6.2 Indexes

```javascript
db.actors.createIndex({ "display_name": 1 });
db.actors.createIndex({ "actor_type": 1 });
db.actors.createIndex({ "last_seen": -1 });
```

### 6.3 Actor Reference in Documents

When a treatment or entry is created with verified identity:

```javascript
// treatments collection
{
  "_id": ObjectId("..."),
  "eventType": "Correction Bolus",
  "insulin": 2.5,
  "created_at": "2026-01-15T14:30:00Z",
  
  // Legacy field (deprecated but maintained for compatibility)
  "enteredBy": "Mom",
  
  // New verified actor reference
  "actor_ref": "kratos-user-uuid",
  "actor_type": "human",
  
  // Delegation info if applicable
  "acted_by": null  // or { "ref": "...", "display_name": "..." }
}
```

---

## 7. Nightscout Core Plugin Requirements

### 7.1 Plugin Configuration

**Environment Variables:**
```bash
# OIDC Configuration
OIDC_ISSUER=https://nrg.example.com
OIDC_CLIENT_ID=ns-site-abc123
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://my-site.example.com/oidc/callback
OIDC_SCOPES=openid profile nightscout:actor

# Feature Flags
OIDC_ENABLED=true
OIDC_REQUIRE_ACTOR=false  # If true, block writes without verified actor
```

### 7.2 Plugin Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/oidc/login` | GET | Initiate OIDC login flow |
| `/oidc/callback` | GET | Handle authorization code callback |
| `/oidc/logout` | GET/POST | Clear session, optionally IdP logout |
| `/oidc/userinfo` | GET | Return current actor info |

### 7.3 Middleware Integration

```javascript
// Pseudo-code for OIDC middleware
function oidcMiddleware(req, res, next) {
  // 1. Check for existing session with actor
  if (req.session?.actor) {
    req.actor = req.session.actor;
    return next();
  }
  
  // 2. Check for Bearer token with actor claims
  const token = extractBearerToken(req);
  if (token) {
    try {
      const claims = verifyAndExtractClaims(token);
      req.actor = mapClaimsToActor(claims);
      return next();
    } catch (err) {
      // Token invalid, fall through
    }
  }
  
  // 3. Check for legacy auth (API_SECRET, access token)
  // These don't provide verified actor identity
  if (hasLegacyAuth(req)) {
    req.actor = null;  // No verified actor
    return next();
  }
  
  // 4. No auth - apply default permissions
  next();
}
```

### 7.4 Data Mutation Hooks

```javascript
// Before saving a treatment
function beforeTreatmentSave(treatment, ctx) {
  if (ctx.actor) {
    treatment.actor_ref = ctx.actor.sub;
    treatment.actor_type = ctx.actor.actor_type;
    
    // Also set legacy field for backwards compatibility
    treatment.enteredBy = ctx.actor.display_name;
    
    // Handle delegation
    if (ctx.actor.act) {
      treatment.acted_by = {
        ref: ctx.actor.act.sub,
        display_name: ctx.actor.act['ns:display_name']
      };
    }
    
    // Upsert actor to lookup collection
    upsertActor(ctx.actor);
  }
  
  return treatment;
}
```

---

## 8. Migration Path for enteredBy

### 8.1 Phase 1: Dual Write (Current → +6 months)

- Continue accepting `enteredBy` from clients
- When OIDC actor available, also write `actor_ref`
- Populate `enteredBy` from actor display_name for compatibility

```javascript
// Both fields written
{
  "enteredBy": "Mom",      // From actor.display_name
  "actor_ref": "uuid-123"  // From actor.sub
}
```

### 8.2 Phase 2: Actor Preferred (+6 → +12 months)

- Read primarily from `actor_ref`
- Fall back to `enteredBy` for historical data
- Encourage clients to send OIDC tokens

### 8.3 Phase 3: Deprecation (+12 months+)

- `enteredBy` marked deprecated
- Warnings in API responses when using unverified `enteredBy`
- Migration tool to backfill actor records from `enteredBy` patterns

### 8.4 Backwards Compatibility

```javascript
// API response includes both for compatibility
{
  "enteredBy": "Mom",
  "actor": {
    "ref": "uuid-123",
    "display_name": "Mom",
    "type": "human",
    "verified": true
  }
}
```

---

## 9. Implementation Readiness

### 9.1 NRG Gateway Changes

| Task | Effort | Status |
|------|--------|--------|
| Expose `/.well-known/openid-configuration` | Low | Ready |
| Add actor claims to token response | Medium | In Progress |
| Implement delegation (act claim) | Medium | Planned |
| Document OIDC endpoints | Low | Planned |

### 9.2 Nightscout Core Changes

| Task | Effort | Status |
|------|--------|--------|
| OIDC plugin scaffold | Medium | Not Started |
| Session management with actor | Medium | Not Started |
| Actor lookup collection | Low | Not Started |
| Mutation hooks for actor_ref | Medium | Not Started |
| API response formatting | Low | Not Started |
| Migration tooling | Medium | Not Started |

### 9.3 Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│                    Implementation Order                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. NRG: Expose OIDC discovery endpoint                     │
│     └──▶ 2. NRG: Add actor claims to token                  │
│          └──▶ 3. NS: OIDC plugin (login/callback)           │
│               └──▶ 4. NS: Actor lookup collection           │
│                    └──▶ 5. NS: Mutation hooks               │
│                         └──▶ 6. NS: Migration tooling       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Test Plan

### 10.1 Unit Tests

| Test Case | Component | Description |
|-----------|-----------|-------------|
| `oidc.claims.parse` | NS Plugin | Parse actor claims from JWT |
| `oidc.claims.validate` | NS Plugin | Validate required claims present |
| `oidc.claims.delegation` | NS Plugin | Handle act claim correctly |
| `actor.upsert` | NS Storage | Create/update actor records |
| `actor.ref.resolve` | NS Storage | Resolve actor_ref to display |
| `mutation.hook.actor` | NS Hooks | Inject actor_ref on save |

### 10.2 Integration Tests

| Test Case | Description | Assertions |
|-----------|-------------|------------|
| Full OIDC flow | Login → callback → session | Actor available in ctx |
| Treatment with actor | Create treatment with OIDC session | actor_ref populated |
| Treatment without actor | Create treatment with API_SECRET | actor_ref null, enteredBy set |
| Delegation flow | Act on behalf via act claim | Both subject and actor recorded |
| Actor lookup | Query actors collection | Returns display_name, type |

### 10.3 E2E Tests

| Scenario | Steps | Expected |
|----------|-------|----------|
| Parent logs in | OIDC flow → careportal | See "Logged in as Mom" |
| Parent adds bolus | Enter insulin → save | Treatment shows "Mom" |
| View who entered | Click treatment | Shows verified badge |
| School nurse access | Delegated token | Treatment shows delegation |

### 10.4 Security Tests

| Test Case | Description | Expected |
|-----------|-------------|----------|
| Token tampering | Modify JWT claims | Reject with 401 |
| Expired token | Use expired JWT | Prompt re-auth |
| Invalid issuer | Token from wrong IdP | Reject with 401 |
| Scope escalation | Request unauthorized scope | Scope denied |
| CSRF on callback | Missing state param | Reject callback |

### 10.5 Migration Tests

| Test Case | Description | Expected |
|-----------|-------------|----------|
| Legacy read | Read treatment with only enteredBy | Return enteredBy |
| Dual write | Save with actor | Both fields populated |
| Actor fallback | Actor ref missing | Use enteredBy |
| Backfill tool | Run migration | Actor records created |

---

## 11. Interview Questions for NS Authors

To ensure this proposal aligns with Nightscout Core maintainer expectations:

### Plugin Architecture

1. **Plugin loading:** How should the OIDC plugin integrate with the existing boot sequence?
2. **Middleware order:** Where should OIDC middleware sit relative to existing auth?
3. **Session storage:** Is there an existing session mechanism or should we add one?

### Data Model

4. **Schema changes:** What's the process for adding new fields to treatments/entries?
5. **Collection creation:** Any conventions for adding new collections (actors)?
6. **Index management:** How are indexes typically managed in deployments?

### Client Compatibility

7. **API versions:** Should actor info be in v1, v2, v3 responses or only v3?
8. **Breaking changes:** What's the tolerance for API response format changes?
9. **Mobile apps:** How do Loop, xDrip+ etc. authenticate today?

### Deployment

10. **Configuration:** Preferred method for OIDC config (env vars, settings.json)?
11. **Feature flags:** How are optional features typically gated?
12. **Rollout:** Preferred approach for gradual feature rollout?

---

## 12. Open Questions

### Technical

| Question | Options | Recommendation |
|----------|---------|----------------|
| Session storage | In-memory, Redis, MongoDB | MongoDB (simpler) |
| Token refresh | Silent refresh, sliding expiry | Sliding expiry |
| Logout scope | Local only, IdP logout | Local + optional IdP |

### Policy

| Question | Stakeholder | Decision Needed |
|----------|-------------|-----------------|
| Required actor for writes? | Maintainers | Phase 2 consideration |
| Default actor_type? | Community | Fallback to "unknown" |
| Delegation approval? | Site owners | Consent flow design |

### Future Extensions

| Feature | Description | Priority |
|---------|-------------|----------|
| Multi-tenant actors | Single actor across multiple sites | Low |
| Actor groups | "Care Team" abstraction | Medium |
| Audit log | Immutable record of actor actions | High |
| Device actors | Loop/OpenAPS as verified agents | Medium |

---

## 13. Appendix: Example Flows

### A.1 Mom Adding Insulin Correction

```
1. Mom navigates to careportal
2. OIDC plugin detects no session
3. Redirect to NRG /oauth2/authorize
4. NRG checks Kratos session (already logged in)
5. Redirect back with authorization code
6. NS exchanges code for tokens
7. Token contains:
   {
     "sub": "mom-uuid",
     "ns:display_name": "Mom",
     "ns:actor_type": "human",
     "ns:permissions": ["api:treatments:create"]
   }
8. Mom enters correction bolus in careportal
9. Treatment saved with:
   {
     "eventType": "Correction Bolus",
     "insulin": 2.5,
     "enteredBy": "Mom",
     "actor_ref": "mom-uuid",
     "actor_type": "human"
   }
10. Dashboard shows treatment with verified "Mom" badge
```

### A.2 School Nurse Acting for Patient

```
1. School nurse logs in via OIDC
2. Nurse's account has delegation from patient's parents
3. Token contains:
   {
     "sub": "patient-uuid",
     "ns:display_name": "Patient Jane",
     "act": {
       "sub": "nurse-uuid",
       "ns:display_name": "School Nurse - Maple Elementary"
     }
   }
4. Nurse enters carb treatment
5. Treatment saved with:
   {
     "eventType": "Carb Correction",
     "carbs": 15,
     "enteredBy": "School Nurse (for Patient Jane)",
     "actor_ref": "patient-uuid",
     "actor_type": "human",
     "acted_by": {
       "ref": "nurse-uuid",
       "display_name": "School Nurse - Maple Elementary"
     }
   }
6. Parents can see nurse's actions clearly attributed
```

### A.3 Loop Making Automated Decision

```
1. Loop authenticates via client credentials flow
2. Token contains:
   {
     "sub": "loop-device-uuid",
     "ns:display_name": "Loop iPhone",
     "ns:actor_type": "agent"
   }
3. Loop uploads device status and temp basal
4. Records saved with:
   {
     "enteredBy": "Loop iPhone",
     "actor_ref": "loop-device-uuid",
     "actor_type": "agent"
   }
5. UI can distinguish automated vs manual decisions
```

---

## 14. References

### Internal Documents

- [Authorization and Security Requirements](../requirements/authorization-security-requirements.md)
- [Architecture Overview](../meta/architecture-overview.md)
- [Security Audit](../audits/security-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)

### External Standards

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 (RFC 6749)](https://tools.ietf.org/html/rfc6749)
- [JWT (RFC 7519)](https://tools.ietf.org/html/rfc7519)
- [Token Exchange (RFC 8693)](https://tools.ietf.org/html/rfc8693)
- [Apache Shiro Permissions](https://shiro.apache.org/permissions.html)

### NRG Gateway

- [nightscout-roles-gateway Repository](https://github.com/t1pal/nightscout-roles-gateway)
- [Ory Hydra Documentation](https://www.ory.sh/hydra/docs/)
- [Ory Kratos Documentation](https://www.ory.sh/kratos/docs/)

---

## 15. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | January 2026 | NRG Team | Initial RFC draft |
| 0.2 | January 2026 | NS Team | Added test plan, integration notes |
