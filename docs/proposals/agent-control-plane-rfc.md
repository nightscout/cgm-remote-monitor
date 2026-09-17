# RFC: Agentic Control Plane for Automated Insulin Delivery Systems

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Authors:** Nightscout Community  
**Created:** 2026-01-01

---

## Abstract

This RFC proposes a clean separation between **control plane** (policy, configuration, intent) and **data plane** (observations, telemetry, delivery) for Nightscout and compatible automated insulin delivery (AID) systems like Loop, Trio, and AAPS.

The goal is to enable **agentic collaboration**—where AI agents, caregivers, and automation systems can safely participate in therapy management alongside the primary controller—while maintaining MDI (manual insulin delivery) as an always-valid fallback.

---

## Table of Contents

1. [Motivation](#motivation)
2. [Design Principles](#design-principles)
3. [Architecture Overview](#architecture-overview)
4. [Core Data Model](#core-data-model)
   - [Event Envelope](#event-envelope)
   - [Configuration Objects](#configuration-objects)
   - [Runtime State Objects](#runtime-state-objects)
   - [Computed State Objects](#computed-state-objects)
   - [Delivery Tracking Objects](#delivery-tracking-objects)
   - [Capabilities Model](#capabilities-model)
5. [API Design](#api-design)
6. [Bridge Mode: Legacy Compatibility](#bridge-mode-legacy-compatibility)
7. [Multi-Writer Semantics & Conflict Resolution](#multi-writer-semantics--conflict-resolution)
8. [Security & Authority Model](#security--authority-model)
9. [Implementation Phases](#implementation-phases)
10. [Integration Questions for Loop/AAPS/Trio](#integration-questions-for-loopaapstrio)
11. [Appendix: JSON Schemas](#appendix-json-schemas)

---

## Motivation

### Current State Problems

1. **Profiles as monolithic blobs** — Entire profile uploaded on every change; no versioning, content-hashing, or stable identifiers
2. **Overrides buried in devicestatus** — Temporary adjustments embedded in controller snapshots rather than discrete, auditable events
3. **No "effective policy" view** — No materialized representation of "what parameters are actually in force right now"
4. **Implicit authority** — No distinction between human intent, controller automation, and delegated agent actions
5. **Intent vs. reality gap** — Difficult to distinguish suggested actions from requested commands from confirmed delivery

### Why This Matters for Agents

For AI agents to safely assist with therapy management (reconciling hormone cycles, activity levels, geolocation, stress indicators), they need:

- **Clear authority boundaries** — What can an agent suggest vs. activate?
- **Audit trails** — Who changed what, when, and why?
- **Composable overrides** — Layer multiple adjustments without conflicts
- **Real-time policy state** — What's actually in force right now?
- **Delivery verification** — Did the suggested action actually happen?

---

## Design Principles

1. **Config vs. Runtime vs. Computed** — Separate user-authored configuration from runtime activations from computed effective state
2. **Events over Snapshots** — Append-only event streams with cursor-based sync, not mutable state blobs
3. **MDI as First-Class** — Manual injections are DeliveryObservations from a human source; the system never assumes automation
4. **Authority Hierarchy** — Human > Agent > Controller for conflict resolution
5. **Bridge Compatibility** — Synthesize canonical events from legacy devicestatus uploads
6. **Neutral Control Plane** — Nightscout stores intent and policy; controllers execute

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NIGHTSCOUT                                      │
│                         (Neutral Control Plane)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │   CONFIG OBJECTS     │  │   RUNTIME EVENTS     │  │  COMPUTED STATE   │  │
│  │                      │  │                      │  │                   │  │
│  │ • ProfileDefinition  │  │ • ProfileSelection   │  │ • PolicyCompos-   │  │
│  │ • OverrideDefinition │  │ • OverrideInstance   │  │   ition           │  │
│  │ • ControllerKind     │  │ • DeliveryRequest    │  │ • CapabilitySnap- │  │
│  │   Definition         │  │ • DeliveryObserv-    │  │   shot            │  │
│  │                      │  │   ation              │  │                   │  │
│  └──────────────────────┘  │ • Reconciliation     │  └───────────────────┘  │
│                            └──────────────────────┘                          │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         EVENT STREAM                                  │   │
│  │  cursor-ordered, append-only, per-issuer sequencing                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                              DATA PLANE                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │      ENTRIES         │  │     TREATMENTS       │  │   DEVICESTATUS    │  │
│  │  (CGM readings)      │  │  (carbs, insulin)    │  │   (legacy blob)   │  │
│  └──────────────────────┘  └──────────────────────┘  └───────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│      LOOP       │         │      TRIO       │         │      AAPS       │
│   (Controller)  │         │   (Controller)  │         │   (Controller)  │
└─────────────────┘         └─────────────────┘         └─────────────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   AI AGENT      │         │   CAREGIVER     │         │    HUMAN        │
│  (delegated)    │         │     (remote)    │         │   (primary)     │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

---

## Core Data Model

### Event Envelope

All state changes are wrapped in an **Event Envelope** for consistent ordering, replay, and audit.

```yaml
EventEnvelope:
  eventId: string          # Stable UUID
  eventType: string        # e.g., "profile.definition.created", "override.instance.activated"
  cursor: integer          # Server-assigned monotonic global ordering
  issuer: string           # Controller/user/agent identifier
  issuerSeq: integer       # Monotonic sequence per issuer
  idempotencyKey: string   # For retry deduplication
  timestamp: datetime      # ISO 8601
  refs:                    # Referenced object IDs/hashes
    - refType: string
      refId: string
  payload: object          # The actual event data
```

**Event Types:**

| Category | Event Types |
|----------|-------------|
| Profile | `profile.definition.created`, `profile.definition.updated`, `profile.selection.changed` |
| Override | `override.definition.created`, `override.instance.activated`, `override.instance.ended`, `override.instance.superseded` |
| Policy | `policy.composition.computed` |
| Delivery | `delivery.requested`, `delivery.observed`, `delivery.reconciled` |
| Capability | `controller.registered`, `capability.snapshot.updated` |

---

### Configuration Objects

These are **user-authored, versioned, addressable** objects.

#### ProfileDefinition

```yaml
ProfileDefinition:
  profileId: string              # Stable identifier
  contentHash: string            # SHA-256 of canonicalized content
  title: string                  # Human-readable name
  timezone: string               # IANA timezone
  units: "mg/dL" | "mmol/L"
  
  schedules:
    basal:                       # Time-based basal rates
      - time: "HH:MM"
        rate: number             # U/hr
    isf:                         # Insulin sensitivity factor
      - time: "HH:MM"
        value: number
    cr:                          # Carb ratio
      - time: "HH:MM"
        value: number
    target:                      # Target glucose ranges
      - time: "HH:MM"
        low: number
        high: number
  
  insulinModel:
    type: "rapid" | "fiasp" | "lyumjev" | "custom"
    dia: number                  # Duration of insulin action (hours)
    peakTime: number             # Minutes to peak
  
  createdBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
  createdAt: datetime
  
  legacyProfileName: string      # For backward compatibility mapping
```

#### OverrideDefinition

```yaml
OverrideDefinition:
  definitionId: string
  overrideType: "exercise" | "sleep" | "preMeal" | "illness" | "highActivity" | "hormones" | "custom"
  title: string
  defaultDuration: integer       # seconds, null = indefinite
  
  effects:
    targetRange:
      low: number
      high: number
    targetDelta: number          # mg/dL adjustment to existing target
    basalMultiplier: number      # 1.0 = no change, 0.5 = 50%
    maxBasalCeiling: number      # U/hr cap
    sensitivityMultiplier: number
    carbRatioMultiplier: number
    automationAggressiveness: number  # 0.0 - 1.0 if controller supports
  
  createdBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
  createdAt: datetime
```

---

### Runtime State Objects

These represent **concrete activations and intents**.

#### ProfileSelection

```yaml
ProfileSelection:
  selectionId: string
  selectedProfileId: string
  selectedProfileHash: string    # For verification
  effectiveAt: datetime
  
  selectedBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
    authority: "primary" | "delegated" | "automated"
  
  reason: string                 # Optional annotation
```

#### OverrideInstance

```yaml
OverrideInstance:
  instanceId: string
  definitionId: string           # Optional - may be ad-hoc
  
  start: datetime
  duration: integer              # seconds, null = indefinite
  end: datetime                  # Computed or explicit
  
  effectiveEffects:              # Resolved effects (may differ from definition)
    targetRange:
      low: number
      high: number
    basalMultiplier: number
    sensitivityMultiplier: number
    carbRatioMultiplier: number
  
  requestedBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
    authority: "primary" | "delegated" | "automated"
  
  status: "active" | "ended" | "canceled" | "superseded"
  supersededBy: string           # instanceId of superseding override
  
  reason: string                 # Why this override was activated
  annotations: object            # Extensible metadata
```

---

### Computed State Objects

These are **materialized views** computed by Nightscout from events.

#### PolicyComposition

```yaml
PolicyComposition:
  compositionId: string
  
  references:
    profileId: string
    profileHash: string
    activeOverrideInstanceIds: [string]
    capabilitySnapshotId: string
  
  effectiveParameters:
    targetRange:
      low: number
      high: number
    effectiveISF: number
    effectiveCR: number
    effectiveBasal: number       # Current scheduled rate after multipliers
    maxBasalAllowed: number
    maxBolusAllowed: number
    automationEnabled: boolean
  
  computedBy:
    controllerKind: string
    controllerVersion: string
    computedAt: datetime
  
  validFrom: datetime
  validTo: datetime              # null = current
  
  cursor: integer                # For ordering
```

---

### Delivery Tracking Objects

These complete the **intent → action → confirmation** loop.

#### DeliveryRequest

```yaml
DeliveryRequest:
  requestId: string
  requestType: "tempBasal" | "bolus" | "suspend" | "resume"
  
  parameters:
    rate: number                 # U/hr for temp basal
    units: number                # Units for bolus
    duration: integer            # seconds for temp basal
  
  requestedBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
  
  basedOn:
    policyCompositionId: string
    algorithmSuggestion: object  # Optional: the suggestion that led to this
  
  requestedAt: datetime
  expiresAt: datetime            # Request is stale after this
```

#### DeliveryObservation

```yaml
DeliveryObservation:
  observationId: string
  observationType: "basal" | "bolus" | "suspend" | "injection" | "pen"
  
  source:
    sourceType: "pump" | "manual" | "pen" | "inhaler"
    sourceId: string             # Device identifier
    sourceKind: string           # "omnipod" | "medtronic" | "tandem" | "pen"
  
  observed:
    rate: number
    units: number
    duration: integer
    startTime: datetime
    endTime: datetime
  
  confidence: "confirmed" | "inferred" | "reported"
  
  reportedBy:
    issuerType: "human" | "controller" | "agent"
    issuerId: string
  
  observedAt: datetime
  
  pumpResponse:
    acked: boolean
    errorCode: string
    errorMessage: string
```

#### Reconciliation

```yaml
Reconciliation:
  reconciliationId: string
  
  requestId: string              # The DeliveryRequest
  observationId: string          # The DeliveryObservation
  
  outcome: "matched" | "partial" | "blocked" | "unknown" | "expired"
  
  discrepancy:
    requestedUnits: number
    deliveredUnits: number
    delta: number
    reason: string               # "capped_by_limit" | "comm_failure" | "user_canceled" | "pump_error"
  
  reconciledAt: datetime
  reconciledBy:
    issuerType: "controller" | "agent"
    issuerId: string
```

---

### Capabilities Model

For "digital twin honesty"—knowing what the controller can actually do right now.

#### ControllerKindDefinition

```yaml
ControllerKindDefinition:
  kindId: string                 # "loop" | "trio" | "aaps" | "openaps"
  version: string
  
  supportedFeatures:
    tempBasal: boolean
    microBolus: boolean
    suspend: boolean
    overrides: boolean
    autoSens: boolean
    dynamicISF: boolean
    dynamicCR: boolean
    smbWithCOB: boolean
    uam: boolean
  
  supportedPumps: [string]
  supportedCGMs: [string]
  
  eventCapabilities:
    canEmitNativeEvents: boolean
    minimalEventSet: [string]    # Event types it can emit
```

#### ControllerInstanceRegistration

```yaml
ControllerInstanceRegistration:
  instanceId: string
  kindId: string
  version: string
  
  device:
    deviceId: string
    platform: "ios" | "android" | "linux"
    model: string
  
  pumpBinding:
    pumpKind: string
    pumpSerial: string
    connectedSince: datetime
  
  cgmBinding:
    cgmKind: string
    cgmId: string
  
  registeredAt: datetime
  lastSeenAt: datetime
```

#### CapabilitySnapshot

```yaml
CapabilitySnapshot:
  snapshotId: string
  controllerInstanceId: string
  
  connectivity:
    pumpConnected: boolean
    pumpLastContact: datetime
    cgmConnected: boolean
    cgmLastReading: datetime
  
  automationState:
    closedLoopEnabled: boolean
    suspended: boolean
    suspendReason: string
  
  effectiveLimits:
    maxBasal: number
    maxBolus: number
    maxIOB: number
  
  health:
    reservoirUnits: number
    batteryPercent: number
    cgmCalibrationStatus: string
    timeSyncHealth: "good" | "drift" | "unknown"
  
  snapshotAt: datetime
```

---

## API Design

### New Collections (API v3)

| Collection | Operations | Description |
|------------|------------|-------------|
| `/profileDefinitions` | CRUD + history | User-authored profile configs |
| `/profileSelections` | CRUD + history | Profile activation events |
| `/overrideDefinitions` | CRUD + history | Reusable override templates |
| `/overrideInstances` | CRUD + history | Concrete override activations |
| `/policyCompositions` | Read + history | Computed effective policy (read-only) |
| `/deliveryRequests` | CRUD + history | Delivery intent records |
| `/deliveryObservations` | CRUD + history | Confirmed delivery records |
| `/reconciliations` | Read + history | Request/observation matching |
| `/controllerRegistrations` | CRUD + history | Controller instance registry |
| `/capabilitySnapshots` | CRUD + history | Controller capability state |
| `/events` | Read + subscribe | Unified event stream |

### Event Stream Endpoint

```
GET /api/v3/events?cursor={lastCursor}&eventTypes={types}&issuers={ids}
```

Returns events after the given cursor, optionally filtered by type and issuer.

### WebSocket / SSE Subscriptions

```
WS /api/v3/events/subscribe
SSE /api/v3/events/stream?cursor={cursor}
```

Real-time event delivery with cursor-based resumption.

---

## Bridge Mode: Legacy Compatibility

For controllers that continue uploading `devicestatus` blobs, Nightscout synthesizes canonical events.

### Bridge Processing Pipeline

```
devicestatus upload
       │
       ▼
┌──────────────────────┐
│  Parse devicestatus  │
│  • Extract profile   │
│  • Extract overrides │
│  • Extract pump      │
│  • Extract suggested │
│  • Extract enacted   │
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  Diff against last   │
│  known state         │
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  Emit events:        │
│  • ProfileDefinition │  (if profile content hash changed)
│  • ProfileSelection  │  (if active profile changed)
│  • OverrideInstance  │  (if override state changed)
│  • PolicyComposition │  (always, as snapshot)
│  • DeliveryObserv-   │  (if enacted present)
│    ation             │
└──────────────────────┘
       │
       ▼
┌──────────────────────┐
│  Store devicestatus  │
│  with bridge refs    │
└──────────────────────┘
```

### Bridge Rules

1. **Profile hashing:** Canonicalize (sort keys, normalize units/timezone), then SHA-256
2. **Override diffing:** Compare active override state; emit `activated`/`ended` as needed
3. **Delivery extraction:** Map `enacted` to `DeliveryObservation`, `suggested` to metadata
4. **Idempotency:** Use `(issuer, issuerSeq)` or `(devicestatus._id, field)` for dedup

---

## Multi-Writer Semantics & Conflict Resolution

### Writers

Nightscout accepts inputs from:
- Controller app (primary automation)
- Caregiver app (remote monitoring/intervention)
- AI agents (delegated assistance)
- Manual UI (user-initiated)
- Bridge (synthesized from legacy uploads)

### Authority Hierarchy

```
HUMAN (primary)
   │
   ├── HUMAN (caregiver, delegated)
   │
   ├── AGENT (delegated)
   │
   └── CONTROLLER (automated)
```

### Conflict Rules

1. **Override composition:** Multiple active overrides are composed into PolicyComposition; conflicts resolved by:
   - Most restrictive target range
   - Lowest basal multiplier (safety bias)
   - Human > Agent > Controller authority

2. **Supersession:** A new override of the same type from equal or higher authority supersedes the previous

3. **Flip-flop prevention:** 
   - Rate limiting per issuer (max N changes per time window)
   - Cooldown period after override end before same type can be activated
   - Agent-initiated overrides require human confirmation if >N in period

4. **Profile selection:** Most recent selection wins; PolicyComposition always references current selection

---

## Security & Authority Model

### Identity Model

| Issuer Type | Identity Mechanism |
|-------------|-------------------|
| Human | OAuth identity (Nightscout account) |
| Controller | Device-bound API key + device attestation |
| Agent | OAuth + scoped delegation token |
| Caregiver | OAuth + explicit delegation grant |

### Authority Scopes

```yaml
Scopes:
  read:
    - entries.read
    - treatments.read
    - policy.read
    - delivery.read
  
  suggest:
    - override.suggest      # Can propose, human must approve
    - delivery.suggest
  
  activate:
    - override.activate     # Can directly activate
    - profile.select
  
  deliver:
    - delivery.request      # Can issue delivery requests
  
  admin:
    - controller.register
    - delegation.grant
```

### Delegation Model

```yaml
DelegationGrant:
  grantId: string
  grantedBy: string          # Human issuer ID
  grantedTo: string          # Agent/caregiver issuer ID
  
  scopes: [string]
  
  constraints:
    maxOverrideDuration: integer
    allowedOverrideTypes: [string]
    requireConfirmation: boolean
    expiresAt: datetime
  
  grantedAt: datetime
  revokedAt: datetime
```

### Audit Requirements

1. All events are append-only
2. Events include `issuer`, `authority`, `timestamp`
3. Optional: issuer-signed events with device keys
4. Optional: hash chain per issuer for tamper evidence

---

## Implementation Phases

### Phase 1: Foundation (4-6 weeks)

**Goal:** Core event model and minimal collections

- [ ] EventEnvelope schema and storage
- [ ] ProfileDefinition collection with content hashing
- [ ] OverrideInstance collection
- [ ] PolicyComposition collection (computed)
- [ ] Basic bridge from devicestatus
- [ ] Cursor-based event polling endpoint
- [ ] SSE subscription (before WebSocket)

**Deliverables:**
- New API v3 collections operational
- Legacy devicestatus → event synthesis working
- Clients can poll for events

### Phase 2: Delivery & Capabilities (4-6 weeks)

**Goal:** Complete intent-to-delivery loop

- [ ] DeliveryRequest / DeliveryObservation / Reconciliation
- [ ] ControllerKindDefinition / ControllerInstanceRegistration
- [ ] CapabilitySnapshot
- [ ] Enhanced bridge for delivery extraction
- [ ] WebSocket subscriptions

**Deliverables:**
- Full delivery tracking operational
- Controller capability awareness
- Real-time subscriptions

### Phase 3: Agents & Delegation (6-8 weeks)

**Goal:** Safe multi-writer with agents

- [ ] Authority scopes and delegation grants
- [ ] Agent identity and authentication
- [ ] Conflict resolution rules
- [ ] Rate limiting and flip-flop prevention
- [ ] Confirmation workflows for agent suggestions
- [ ] Audit dashboard

**Deliverables:**
- Agents can suggest overrides
- Caregivers can delegate to agents
- Full audit trail

---

## Integration Questions for Loop/AAPS/Trio

See [integration-questionnaire.md](./integration-questionnaire.md) for the complete questionnaire.

### Key Questions Summary

**A) Profiles & Overrides**
1. Do you have stable profile identifiers beyond name?
2. Can you represent overrides as template vs. activation?
3. What override dimensions exist (target, sensitivity, basal, CR)?
4. How do you resolve multiple concurrent overrides?

**B) Composition**
5. Do you compute an explicit "effective therapy settings" internally?
6. Can you emit: profile hash + override IDs + effective parameters?

**C) Delivery Fidelity**
7. Can you distinguish suggested vs. requested vs. confirmed?
8. Do you surface pump ACK/NAK/error codes?
9. How do you represent "capped by limits" vs. "comm failure"?

**D) Timing & Ordering**
10. Can you provide monotonic per-controller sequencing?
11. How do you handle offline batching?

**E) Minimal Commitment**
12. What's the smallest native event set you'd emit first?

---

## Appendix: JSON Schemas

Full JSON Schema (draft-2020-12) files are available in the `schemas/` directory:

- [event-envelope.schema.json](./schemas/event-envelope.schema.json)
- [profile-definition.schema.json](./schemas/profile-definition.schema.json)
- [profile-selection.schema.json](./schemas/profile-selection.schema.json)
- [override-definition.schema.json](./schemas/override-definition.schema.json)
- [override-instance.schema.json](./schemas/override-instance.schema.json)
- [policy-composition.schema.json](./schemas/policy-composition.schema.json)
- [delivery-request.schema.json](./schemas/delivery-request.schema.json)
- [delivery-observation.schema.json](./schemas/delivery-observation.schema.json)
- [reconciliation.schema.json](./schemas/reconciliation.schema.json)
- [controller-kind-definition.schema.json](./schemas/controller-kind-definition.schema.json)
- [controller-instance-registration.schema.json](./schemas/controller-instance-registration.schema.json)
- [capability-snapshot.schema.json](./schemas/capability-snapshot.schema.json)

---

## References

- [Nightscout API v3 Documentation](../api3/swagger.yaml)
- [Loop Documentation](https://loopkit.github.io/loopdocs/)
- [AAPS Documentation](https://androidaps.readthedocs.io/)
- [OpenAPS Documentation](https://openaps.readthedocs.io/)

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-01 | Initial draft |
