# Test Coverage Gaps - Aggregated View

**Last Updated:** January 2026

This document aggregates coverage gaps from all test specifications to provide a prioritized view for planning test development work.

---

## High Priority Gaps

These gaps represent security-critical or data-critical functionality that should be addressed first.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Authorization | WebSocket Auth (`/storage` subscription) | `authorization-tests.md` | Add socket.io-client tests for subscribe with/without token |
| Authorization | JWT Expiration rejection | `authorization-tests.md` | Create JWT with past exp, verify 401 |
| Authorization | Permission Wildcards (Shiro patterns) | `authorization-tests.md` | Test `api:*:read` vs `api:entries:read` |
| Authorization | API v3 Security model | `authorization-tests.md` | Create separate API v3 security spec |

---

## Medium Priority Gaps

These gaps represent functional coverage that should be addressed after high priority items.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Shape Handling | Response order matches input order | `shape-handling-tests.md` | Add order verification tests |
| Shape Handling | WebSocket + API concurrent writes | `shape-handling-tests.md` | Complex test setup needed |
| Shape Handling | Duplicate identifier handling under load | `shape-handling-tests.md` | Stress test harness needed |
| Shape Handling | Cross-API consistency (v1 vs v3 storage) | `shape-handling-tests.md` | Cross-read verification tests |
| Authorization | Subject CRUD operations | `authorization-tests.md` | Add API tests for admin endpoints |
| Authorization | Role Management | `authorization-tests.md` | Test role creation and permission assignment |

---

## Low Priority Gaps

These gaps are edge cases or lower-risk functionality.

| Area | Gap | Source Spec | Recommended Action |
|------|-----|-------------|-------------------|
| Shape Handling | Null/undefined in array handling | `shape-handling-tests.md` | Define expected behavior, add tests |
| Authorization | Audit Events | `authorization-tests.md` | Mock bus, verify admin-notify event |
| Authorization | Delay Cleanup | `authorization-tests.md` | Fast-forward time, verify cleanup |

---

## Areas Not Yet Documented

These areas from system audits have not yet been converted to formal requirements/test specifications:

| Area | Source Audit | Priority | Blocking Issue |
|------|--------------|----------|----------------|
| API v3 Security | `security-audit.md` | High | Distinct auth model from v1/v2 |
| Core Calculations (IOB/COB) | `plugin-architecture-audit.md` | High | Complex algorithms, domain expertise needed |
| Real-time Event Bus | `realtime-systems-audit.md` | Medium | Need to trace event flows |
| Plugin System | `plugin-architecture-audit.md` | Medium | Large surface area |
| Notification/Messaging | `messaging-subsystem-audit.md` | Medium | Multiple providers |
| Dashboard UI | `dashboard-ui-audit.md` | Low | May be rewritten |

---

## Gap Resolution Process

When addressing a gap:

1. **Review the source spec** - Understand the context and related requirements
2. **Write the test first** - Follow Test ID conventions from the source spec
3. **Update the source spec** - Mark the gap as covered, add test details
4. **Update this file** - Remove the gap from this aggregated view
5. **Update the Progress section** - Note the date and any discoveries

---

## Cross-References

- [Shape Handling Tests](shape-handling-tests.md)
- [Authorization Tests](authorization-tests.md)
- [Documentation Progress](../meta/DOCUMENTATION-PROGRESS.md)
