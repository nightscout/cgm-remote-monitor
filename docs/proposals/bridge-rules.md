# Bridge Mode: Legacy devicestatus to Event Synthesis

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Related:** [Agent Control Plane RFC](./agent-control-plane-rfc.md), [Integration Questionnaire](./integration-questionnaire.md)

---

## Purpose

Define rules for synthesizing canonical control plane events from legacy `devicestatus` uploads, enabling backward compatibility while controllers transition to native event emission.

---

## Overview

Bridge mode enables Nightscout to:
1. Accept legacy `devicestatus` uploads unchanged
2. Parse and extract control plane information
3. Synthesize canonical events (`ProfileDefinition`, `OverrideInstance`, `PolicyComposition`, etc.)
4. Store both the original devicestatus and synthesized events
5. Enable event-based queries and subscriptions

```
┌─────────────────────────────────────────────────────────────────┐
│                    DEVICESTATUS UPLOAD                          │
│   POST /api/v1/devicestatus                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BRIDGE PROCESSOR                             │
│                                                                 │
│  1. Store original devicestatus                                 │
│  2. Identify controller type (loop, openaps, aaps)              │
│  3. Extract profile information                                 │
│  4. Extract override state                                      │
│  5. Extract delivery information                                │
│  6. Compute diffs from last known state                         │
│  7. Emit synthesized events                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EVENT STREAM                                 │
│                                                                 │
│  • ProfileDefinition (if hash changed)                          │
│  • ProfileSelection (if active profile changed)                 │
│  • OverrideInstance (start/end as needed)                       │
│  • PolicyComposition (always)                                   │
│  • DeliveryObservation (if enacted present)                     │
│  • CapabilitySnapshot (if pump/cgm status present)              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Controller Detection

### Detection Rules

```javascript
function detectControllerType(devicestatus) {
  if (devicestatus.loop) return 'loop';
  if (devicestatus.openaps) return 'openaps';
  if (devicestatus.pump && devicestatus.pump.source === 'AAPS') return 'aaps';
  if (devicestatus.trio) return 'trio';
  return 'unknown';
}
```

### Controller-Specific Parsers

Each controller type has a dedicated parser:

| Controller | Parser Module | Primary Fields |
|------------|--------------|----------------|
| Loop | `parsers/loop.js` | `loop.enacted`, `loop.predicted`, `loop.override` |
| OpenAPS | `parsers/openaps.js` | `openaps.suggested`, `openaps.enacted`, `openaps.iob` |
| AAPS | `parsers/aaps.js` | `pump`, `configuration` |
| Trio | `parsers/trio.js` | `trio.enacted`, `trio.override` |

---

## Profile Extraction & Hashing

### Canonicalization Rules

Before hashing, profiles must be canonicalized:

1. **Sort keys** alphabetically at all levels
2. **Normalize timezone** to IANA format
3. **Normalize units** to lowercase (`mg/dl` → `mg/dL`, `mmol/l` → `mmol/L`)
4. **Normalize times** to `HH:MM` format (zero-padded)
5. **Round numbers** to standard precision (rates: 3 decimals, ratios: 2 decimals)
6. **Remove null/undefined** fields
7. **Sort arrays** by time field

```javascript
function canonicalizeProfile(profile) {
  const canonical = {
    basal: sortByTime(profile.basal).map(b => ({
      time: normalizeTime(b.time),
      rate: round(b.rate, 3)
    })),
    isf: sortByTime(profile.sens || profile.isf).map(s => ({
      time: normalizeTime(s.time),
      value: round(s.value, 1)
    })),
    cr: sortByTime(profile.carbratio || profile.cr).map(c => ({
      time: normalizeTime(c.time),
      value: round(c.value, 1)
    })),
    target: sortByTime(profile.target_low ? 
      mergeTargets(profile.target_low, profile.target_high) : 
      profile.target
    ).map(t => ({
      time: normalizeTime(t.time),
      low: round(t.low, 0),
      high: round(t.high, 0)
    })),
    dia: round(profile.dia, 1),
    timezone: normalizeTimezone(profile.timezone),
    units: normalizeUnits(profile.units)
  };
  
  return canonical;
}

function hashProfile(canonicalProfile) {
  const json = JSON.stringify(canonicalProfile, Object.keys(canonicalProfile).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}
```

### Profile Definition Emission

```javascript
function maybeEmitProfileDefinition(devicestatus, lastKnownState) {
  const profile = extractProfile(devicestatus);
  if (!profile) return null;
  
  const canonical = canonicalizeProfile(profile);
  const hash = hashProfile(canonical);
  
  // Check if we've seen this profile before
  if (lastKnownState.profileHashes.has(hash)) {
    return null; // Already exists, no need to emit
  }
  
  return {
    eventType: 'profile.definition.created',
    payload: {
      profileId: generateProfileId(hash),
      contentHash: hash,
      title: profile.profileName || 'Default',
      timezone: canonical.timezone,
      units: canonical.units,
      schedules: {
        basal: canonical.basal,
        isf: canonical.isf,
        cr: canonical.cr,
        target: canonical.target
      },
      insulinModel: {
        dia: canonical.dia
      },
      createdBy: {
        issuerType: 'controller',
        issuerId: devicestatus.device || 'unknown'
      },
      legacyProfileName: profile.profileName
    },
    metadata: {
      bridgeSource: 'devicestatus',
      bridgeSourceId: devicestatus._id
    }
  };
}
```

---

## Override State Extraction

### Loop Override Parsing

```javascript
function parseLoopOverride(devicestatus) {
  const override = devicestatus.loop?.override;
  if (!override) return null;
  
  return {
    active: override.active !== false,
    name: override.name,
    targetRange: override.currentCorrectionRange ? {
      low: override.currentCorrectionRange.minValue,
      high: override.currentCorrectionRange.maxValue
    } : null,
    basalMultiplier: override.multiplier,
    sensitivityMultiplier: override.insulinSensitivityScaleFactor,
    duration: override.duration, // seconds
    startTime: override.startTime || devicestatus.created_at,
    symbol: override.symbol
  };
}
```

### AAPS Override Parsing

```javascript
function parseAAPSOverride(devicestatus) {
  // AAPS uses "Temp Target" and "Profile Switch" differently
  const tempTarget = devicestatus.configuration?.tempTarget;
  const profileSwitch = devicestatus.configuration?.profileSwitch;
  
  const overrides = [];
  
  if (tempTarget && tempTarget.isValid) {
    overrides.push({
      type: 'tempTarget',
      active: true,
      targetRange: {
        low: tempTarget.lowTarget,
        high: tempTarget.highTarget
      },
      reason: tempTarget.reason,
      duration: tempTarget.duration * 60 // minutes to seconds
    });
  }
  
  if (profileSwitch && profileSwitch.percentage !== 100) {
    overrides.push({
      type: 'profilePercentage',
      active: true,
      basalMultiplier: profileSwitch.percentage / 100,
      duration: profileSwitch.duration * 60
    });
  }
  
  return overrides;
}
```

### Override Instance Emission

```javascript
function emitOverrideEvents(currentOverride, lastKnownOverride, issuer) {
  const events = [];
  
  // Detect override start
  if (currentOverride?.active && !lastKnownOverride?.active) {
    events.push({
      eventType: 'override.instance.activated',
      payload: {
        instanceId: generateUUID(),
        start: currentOverride.startTime,
        duration: currentOverride.duration,
        effectiveEffects: {
          targetRange: currentOverride.targetRange,
          basalMultiplier: currentOverride.basalMultiplier,
          sensitivityMultiplier: currentOverride.sensitivityMultiplier
        },
        requestedBy: {
          issuerType: 'controller',
          issuerId: issuer,
          authority: 'automated'
        },
        status: 'active',
        reason: currentOverride.name || currentOverride.reason
      }
    });
  }
  
  // Detect override end
  if (!currentOverride?.active && lastKnownOverride?.active) {
    events.push({
      eventType: 'override.instance.ended',
      payload: {
        instanceId: lastKnownOverride.instanceId,
        status: 'ended',
        endedBy: {
          issuerType: 'controller',
          issuerId: issuer
        }
      }
    });
  }
  
  // Detect override change (supersession)
  if (currentOverride?.active && lastKnownOverride?.active && 
      overridesDiffer(currentOverride, lastKnownOverride)) {
    const newInstanceId = generateUUID();
    events.push({
      eventType: 'override.instance.superseded',
      payload: {
        instanceId: lastKnownOverride.instanceId,
        status: 'superseded',
        supersededBy: newInstanceId
      }
    });
    events.push({
      eventType: 'override.instance.activated',
      payload: {
        instanceId: newInstanceId,
        // ... same as above
      }
    });
  }
  
  return events;
}
```

---

## Policy Composition Synthesis

Always emit a PolicyComposition for every devicestatus, as it represents the current state.

```javascript
function synthesizePolicyComposition(devicestatus, controllerType, state) {
  const profile = extractProfile(devicestatus);
  const override = extractOverride(devicestatus, controllerType);
  const limits = extractLimits(devicestatus, controllerType);
  
  // Compute effective parameters
  const scheduledBasal = getCurrentScheduledValue(profile.basal);
  const basalMultiplier = override?.basalMultiplier || 1.0;
  const effectiveBasal = scheduledBasal * basalMultiplier;
  
  const scheduledTarget = getCurrentScheduledValue(profile.target);
  const effectiveTarget = override?.targetRange || scheduledTarget;
  
  return {
    eventType: 'policy.composition.computed',
    payload: {
      compositionId: generateUUID(),
      references: {
        profileId: state.currentProfileId,
        profileHash: state.currentProfileHash,
        activeOverrideInstanceIds: state.activeOverrideIds,
        capabilitySnapshotId: state.latestCapabilitySnapshotId
      },
      effectiveParameters: {
        targetRange: effectiveTarget,
        effectiveISF: getCurrentScheduledValue(profile.isf),
        effectiveCR: getCurrentScheduledValue(profile.cr),
        effectiveBasal: effectiveBasal,
        scheduledBasal: scheduledBasal,
        basalMultiplier: basalMultiplier,
        maxBasalAllowed: limits.maxBasal,
        maxBolusAllowed: limits.maxBolus,
        maxIOB: limits.maxIOB,
        automationEnabled: extractAutomationState(devicestatus),
        automationMode: extractAutomationMode(devicestatus)
      },
      computedBy: {
        controllerKind: controllerType,
        controllerVersion: devicestatus.version || 'unknown',
        computedAt: new Date().toISOString()
      },
      validFrom: devicestatus.created_at
    }
  };
}
```

---

## Delivery Observation Extraction

### Loop Enacted Parsing

```javascript
function parseLoopEnacted(devicestatus) {
  const enacted = devicestatus.loop?.enacted;
  if (!enacted || !enacted.received) return null;
  
  const observations = [];
  
  // Temp basal
  if (enacted.rate !== undefined) {
    observations.push({
      observationType: 'tempBasal',
      source: {
        sourceType: 'pump',
        sourceKind: devicestatus.pump?.pumpModel || 'unknown'
      },
      observed: {
        rate: enacted.rate,
        duration: enacted.duration * 60, // minutes to seconds
        startTime: enacted.timestamp
      },
      confidence: 'confirmed',
      relatedSuggestion: {
        reason: enacted.reason,
        eventualBG: enacted.eventualBG,
        predBGs: enacted.predBGs
      }
    });
  }
  
  // Bolus (if present)
  if (enacted.units) {
    observations.push({
      observationType: enacted.units < 1 ? 'microBolus' : 'bolus',
      source: {
        sourceType: 'pump',
        sourceKind: devicestatus.pump?.pumpModel || 'unknown'
      },
      observed: {
        units: enacted.units,
        startTime: enacted.timestamp
      },
      confidence: 'confirmed'
    });
  }
  
  return observations;
}
```

### OpenAPS Enacted Parsing

```javascript
function parseOpenAPSEnacted(devicestatus) {
  const enacted = devicestatus.openaps?.enacted;
  const suggested = devicestatus.openaps?.suggested;
  
  if (!enacted) return null;
  
  return {
    observationType: 'tempBasal',
    source: {
      sourceType: 'pump',
      sourceKind: devicestatus.pump?.pumpmanufacturer || 'unknown'
    },
    observed: {
      rate: enacted.rate,
      duration: enacted.duration * 60,
      startTime: enacted.timestamp
    },
    confidence: 'confirmed',
    pumpResponse: {
      acked: true
    },
    relatedSuggestion: suggested ? {
      reason: suggested.reason,
      iob: devicestatus.openaps?.iob?.iob,
      eventualBG: suggested.eventualBG
    } : null
  };
}
```

---

## Capability Snapshot Extraction

```javascript
function extractCapabilitySnapshot(devicestatus, controllerType) {
  const pump = devicestatus.pump || devicestatus.uploaderBattery;
  
  return {
    eventType: 'capability.snapshot.updated',
    payload: {
      snapshotId: generateUUID(),
      controllerInstanceId: devicestatus.device,
      connectivity: {
        pumpConnected: pump?.status?.bolusing !== undefined,
        pumpLastContact: pump?.clock,
        cgmConnected: devicestatus.cgm !== undefined,
        cgmLastReading: devicestatus.cgm?.mills
      },
      automationState: {
        closedLoopEnabled: extractClosedLoopState(devicestatus, controllerType),
        suspended: pump?.status?.suspended || false,
        lastLoopTime: devicestatus.loop?.timestamp || devicestatus.openaps?.suggested?.timestamp
      },
      health: {
        reservoirUnits: pump?.reservoir,
        batteryPercent: pump?.battery?.percent || devicestatus.uploaderBattery,
        phoneBatteryPercent: devicestatus.uploaderBattery
      },
      snapshotAt: devicestatus.created_at
    }
  };
}
```

---

## Idempotency & Deduplication

### Idempotency Keys

For bridge-synthesized events, use deterministic idempotency keys:

```javascript
function generateIdempotencyKey(devicestatusId, eventType, subKey = '') {
  return crypto
    .createHash('sha256')
    .update(`bridge:${devicestatusId}:${eventType}:${subKey}`)
    .digest('hex')
    .substring(0, 32);
}
```

### Deduplication Rules

1. **ProfileDefinition:** Dedupe by `contentHash` — same hash = same profile
2. **OverrideInstance:** Dedupe by `(start, effectiveEffects hash)` within tolerance window
3. **PolicyComposition:** Allow duplicates (they're snapshots), but optimize storage
4. **DeliveryObservation:** Dedupe by `(startTime, type, units/rate)` within 30-second window

---

## State Management

The bridge processor maintains per-device state:

```javascript
const deviceState = {
  deviceId: string,
  lastDevicestatusId: string,
  lastProcessedAt: datetime,
  
  // Profile state
  currentProfileId: string,
  currentProfileHash: string,
  profileHashes: Set<string>,  // All known profile hashes
  
  // Override state
  activeOverrides: [{
    instanceId: string,
    type: string,
    startTime: datetime,
    effectsHash: string
  }],
  
  // Capability state
  latestCapabilitySnapshotId: string,
  
  // Sequence tracking
  issuerSeq: number
};
```

---

## Error Handling

### Parsing Failures

```javascript
function processBridgeWithFallback(devicestatus) {
  try {
    const events = processDevicestatus(devicestatus);
    return { success: true, events };
  } catch (error) {
    console.error('Bridge parsing error:', error);
    
    // Emit a minimal PolicyComposition with error annotation
    return {
      success: false,
      events: [{
        eventType: 'policy.composition.computed',
        payload: {
          compositionId: generateUUID(),
          references: {},
          effectiveParameters: {},
          computedBy: {
            controllerKind: 'unknown',
            computedAt: new Date().toISOString()
          },
          validFrom: devicestatus.created_at
        },
        metadata: {
          bridgeError: error.message,
          bridgeSource: 'devicestatus',
          bridgeSourceId: devicestatus._id
        }
      }]
    };
  }
}
```

### Missing Fields

Handle gracefully with defaults:

```javascript
const DEFAULTS = {
  basalMultiplier: 1.0,
  sensitivityMultiplier: 1.0,
  automationEnabled: true,
  confidence: 'inferred'
};
```

---

## Testing

### Test Cases

1. **Profile change detection** — Same profile should not emit new definition
2. **Override start/end** — Correctly detect transitions
3. **Override supersession** — Detect when override changes while active
4. **Delivery extraction** — Parse all enacted formats
5. **Clock skew** — Handle out-of-order devicestatus
6. **Idempotency** — Retry same devicestatus produces no duplicates
7. **Controller-specific parsing** — Each controller type parsed correctly

### Test Data

See `tests/bridge/fixtures/` for sample devicestatus payloads from each controller.

---

## Configuration

```javascript
const BRIDGE_CONFIG = {
  enabled: true,
  
  // Which controllers to bridge
  controllers: ['loop', 'openaps', 'aaps', 'trio'],
  
  // Event emission
  emitProfileDefinitions: true,
  emitOverrideInstances: true,
  emitPolicyCompositions: true,
  emitDeliveryObservations: true,
  emitCapabilitySnapshots: true,
  
  // Deduplication
  dedupeWindowSeconds: 30,
  
  // State persistence
  stateStorageCollection: 'bridgeState',
  stateExpiryDays: 7,
  
  // Error handling
  continueOnParseError: true,
  logParseErrors: true
};
```
