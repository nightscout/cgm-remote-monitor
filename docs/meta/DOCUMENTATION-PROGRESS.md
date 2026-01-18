# Nightscout Documentation Progress Tracker

## Overview

This document tracks the ongoing effort to produce comprehensive product requirements and test specifications following the component system audits. The goal is to formalize existing behaviors, map tests to requirements, and identify coverage gaps across all major subsystems.

**Started:** January 2026  
**Approach:** Audit-first methodology - review component audits, then create formal requirements specs and test specifications with traceability matrices.

---

## Progress Summary

### Completed Documentation

| Area | Requirements Doc | Test Spec | Status |
|------|------------------|-----------|--------|
| Data Shape Handling | `requirements/data-shape-requirements.md` | `test-specs/shape-handling-tests.md` | Complete |
| API v1 Compatibility | `requirements/api-v1-compatibility-requirements.md` | (integrated) | Complete |
| Authorization/Security | `requirements/authorization-security-requirements.md` | `test-specs/authorization-tests.md` | Complete |
| Treatments Schema | `data-schemas/treatments-schema.md` | N/A | Complete |
| Profiles Schema | `data-schemas/profiles-schema.md` | N/A | Complete |

### System Audits (Reference Documents)

These audits provide the foundation for requirements extraction:

| Audit Document | Subsystem | Req/Test Status |
|----------------|-----------|-----------------|
| `architecture-overview.md` | System-wide | Reference only |
| `security-audit.md` | Auth, brute-force, JWT | Extracted to specs |
| `api-layer-audit.md` | REST v1/v2/v3, WebSocket | Partial (v1 done, v3 needed) |
| `data-layer-audit.md` | MongoDB, collections, sync | Shape handling extracted |
| `realtime-systems-audit.md` | Socket.IO, event bus | Not started |
| `plugin-architecture-audit.md` | 38 plugins, Pebble | Not started |
| `dashboard-ui-audit.md` | Client bundle, D3/jQuery | Not started (may defer) |
| `messaging-subsystem-audit.md` | Pushover, IFTTT, notifications | Not started |
| `modernization-roadmap.md` | Tech debt, refactoring | Reference only |

---

## Priority Queue

### Tier 1: High Priority (Security/Data Critical)

| Area | Why Important | Estimated Effort | Blocking Issues |
|------|---------------|------------------|-----------------|
| **API v3 Security** | Distinct auth model from v1/v2, health data access | Medium | Need to review `lib/api3/security.js` |
| **WebSocket Auth** | Real-time data streams need auth coverage | Medium | Identified as coverage gap |
| **Core Calculations (IOB/COB)** | Critical for diabetes management decisions | High | Complex algorithms, requires domain expertise |

### Tier 2: Medium Priority (Functional Coverage)

| Area | Why Important | Estimated Effort | Blocking Issues |
|------|---------------|------------------|-----------------|
| **Plugin System** | 38 plugins, extensibility foundation | High | Large surface area |
| **Real-time Event Bus** | Data synchronization between components | Medium | Need to trace event flows |
| **Notification/Messaging** | Alerts for dangerous glucose levels | Medium | Multiple providers |

### Tier 3: Lower Priority (UI/UX or Deferred)

| Area | Why Important | Estimated Effort | Blocking Issues |
|------|---------------|------------------|-----------------|
| **Dashboard UI** | User-facing but may be rewritten | Low (defer) | Testing Modernization Proposal suggests UI rewrite |
| **Report Plugins** | Secondary to real-time monitoring | Low | Depends on plugin system work |
| **Pebble Integration** | Legacy smartwatch support | Very Low | Pebble discontinued |

---

## Lessons Learned

### Documentation Patterns That Work

1. **Start with code, not assumptions** - Every requirement must cite a source file and line number.

2. **Separate requirements from implementation details** - Requirements state "what" and "why"; implementation notes explain "how" the code does it.

3. **Test ID conventions** - Using prefixed IDs (SEC-001, HASH-002, etc.) makes traceability matrices scannable and enables automated coverage checks.

4. **Coverage gaps are as valuable as coverage** - Documenting what's NOT tested is critical for security audits and prioritization.

5. **Each area tracks its own progress** - Technical discoveries and coverage gaps are documented in the relevant test spec, not centrally. See `test-specs/coverage-gaps.md` for aggregated view.

### Process Improvements

- **Architect reviews catch accuracy issues** - Multiple review cycles improved documentation accuracy significantly
- **Traceability matrices expose gaps visually** - Easy to spot "Not Covered" in a table
- **Quirks/Barriers sections prevent future frustration** - Document the weird stuff so others don't rediscover it

---

## Open Questions

### Requiring Domain Expert Input

1. **IOB/COB algorithm correctness** - Are the calculation algorithms clinically validated? What are acceptable error bounds?

2. **Alarm threshold safety margins** - What are the clinical requirements for glucose alarm thresholds? Are current defaults evidence-based?

3. **Plugin interaction edge cases** - When multiple plugins modify the same data, what's the expected precedence?

### Requiring Architecture Decisions

1. **API v3 vs v1/v2 long-term** - Should v1/v2 be deprecated? What's the migration timeline?

2. **Rate limiting addition** - Security audit identified missing general rate limiting. Priority?

3. **OIDC/OAuth2 integration** - Modernization roadmap mentions this. Does it supersede current auth model?

4. **Schema registration for controllers** - AAPS, Loop, xDrip use different sync identity fields. Should controllers register their schema conventions?

### Requiring More Investigation

1. **Socket.IO namespace isolation** - Do `/storage` and `/alarm` properly isolate data by authorization level?

2. **MongoDB transaction support** - With MongoDB 5.x, should multi-document writes use transactions?

3. **Event bus memory leaks** - Are there cleanup mechanisms for event subscriptions on disconnect?

---

## For the Next Collaborator

Welcome! If you're picking up this documentation effort, here's how to get started:

### Quick Start

1. **Read the audits first** - The `docs/*-audit.md` files provide system understanding before diving into specs
2. **Pick from the priority queue** - Tier 1 items are most impactful
3. **Follow the established pattern**:
   - Create `docs/requirements/<area>-requirements.md` for formal requirements
   - Create `docs/test-specs/<area>-tests.md` for test mappings
   - Update this progress document when done

### Template Structure

Requirements documents should include:
- Purpose and scope
- Terminology (be precise, cite code)
- Numbered requirements with IDs (REQ-XXX-NNN format)
- Implementation references (file:line)
- Security considerations

Test specifications should include:
- **Progress & Coverage Status** section at top (current state, recent discoveries, priority gaps)
- Existing test inventory with unique IDs
- Test case descriptions with expected behavior
- Requirement traceability matrix
- Discovered quirks and barriers

### Key Files to Understand

- `lib/authorization/index.js` - Main auth entry point
- `lib/server/env.js` - Environment/configuration loading
- `lib/server/bootevent.js` - Server initialization sequence
- `lib/plugins/index.js` - Plugin loading system
- `tests/*.test.js` - Existing test suite

### What NOT to Change

This effort is documentation-only. Do not:
- Modify source code (log bugs separately)
- Add new tests (document gaps for future work)
- Refactor existing tests (conflicts with testing modernization proposal)

### Communication

- Update `replit.md` with significant general discoveries
- Add findings to relevant test spec's Progress section
- Note any blocking issues in the priority queue

Good luck, and thank you for contributing!

---

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-18 | Agent | Reorganized: moved technical discoveries to individual test specs, standardized file naming |
| 2026-01-15 | Agent | Initial document, completed auth/security specs |
| 2026-01-15 | Agent | Added lessons learned, open questions, priority queue |
| 2026-01-15 | Agent | Added data-schemas/treatments-schema.md and profiles-schema.md from domain expert interview |
