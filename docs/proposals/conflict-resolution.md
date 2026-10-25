# Multi-Writer Semantics & Conflict Resolution

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Related:** [Agent Control Plane RFC](./agent-control-plane-rfc.md), [Bridge Rules](./bridge-rules.md)

---

## Purpose

Define rules for handling concurrent inputs from multiple sources (controllers, caregivers, agents, manual UI) to the Nightscout control plane.

---

## Overview

The control plane accepts inputs from multiple writer types, each with different authority levels and use cases. This document defines how conflicts are detected, resolved, and audited.

---

## Writer Types

### Primary Writers

| Writer Type | Description | Authority Level | Examples |
|-------------|-------------|-----------------|----------|
| **Human (Primary)** | The person with diabetes (PWD) or primary caregiver | Highest | User activating override in app |
| **Human (Caregiver)** | Delegated caregiver with explicit permissions | High | Parent adjusting child's settings remotely |
| **Agent** | AI/automated system with delegated authority | Medium | AI agent suggesting/activating sleep mode |
| **Controller** | AID algorithm on device | Base | Loop activating temp basal |

### Writer Identity

Each writer has a unique identity:

```yaml
IssuerIdentity:
  issuerType: "human" | "controller" | "agent" | "caregiver" | "system"
  issuerId: string          # Unique identifier
  authority: "primary" | "delegated" | "automated"
  delegatedBy: string       # If delegated, who granted authority
  delegationScopes: [string] # What actions are permitted
```

---

## Authority Hierarchy

```
┌─────────────────────────────────────────┐
│           HUMAN (PRIMARY)               │  ← Can do anything
│         Authority Level: 100            │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│          HUMAN (CAREGIVER)              │  ← Delegated by primary
│         Authority Level: 80             │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│              AGENT                      │  ← Delegated by primary/caregiver
│         Authority Level: 50             │
└───────────────────┬─────────────────────┘
                    │
┌───────────────────▼─────────────────────┐
│            CONTROLLER                   │  ← Automated, follows policy
│         Authority Level: 30             │
└─────────────────────────────────────────┘
```

### Authority Rules

1. Higher authority can always override lower authority
2. Equal authority uses temporal precedence (last write wins)
3. Lower authority cannot override higher authority actions
4. Controller cannot override active human/agent overrides

---

## Conflict Scenarios

### Scenario 1: Override Supersession

**Situation:** Human starts "Exercise" override, then Agent tries to start "High Activity" override.

**Resolution:**
```javascript
function canSupersede(newOverride, existingOverride) {
  const newAuthority = getAuthorityLevel(newOverride.requestedBy);
  const existingAuthority = getAuthorityLevel(existingOverride.requestedBy);
  
  if (newAuthority > existingAuthority) {
    return { allowed: true, action: 'supersede' };
  }
  
  if (newAuthority === existingAuthority) {
    // Same type? Supersede. Different type? May compose.
    if (newOverride.type === existingOverride.type) {
      return { allowed: true, action: 'supersede' };
    } else {
      return { allowed: true, action: 'compose' };
    }
  }
  
  // Lower authority cannot supersede
  return { 
    allowed: false, 
    reason: 'insufficient_authority',
    requiredAuthority: existingAuthority 
  };
}
```

### Scenario 2: Concurrent Override Composition

**Situation:** Two different override types are active simultaneously.

**Resolution:** Compose effects with conservative (safe) combination:

```javascript
function composeOverrides(overrides) {
  // Sort by authority (highest first), then by start time
  const sorted = sortBy(overrides, ['-authority', 'start']);
  
  const composed = {
    targetRange: null,
    basalMultiplier: 1.0,
    sensitivityMultiplier: 1.0,
    carbRatioMultiplier: 1.0,
    maxBasalCeiling: Infinity
  };
  
  for (const override of sorted) {
    const effects = override.effectiveEffects;
    
    // Target: Use most restrictive (highest low, lowest high)
    if (effects.targetRange) {
      if (!composed.targetRange) {
        composed.targetRange = { ...effects.targetRange };
      } else {
        composed.targetRange.low = Math.max(
          composed.targetRange.low, 
          effects.targetRange.low
        );
        composed.targetRange.high = Math.min(
          composed.targetRange.high, 
          effects.targetRange.high
        );
      }
    }
    
    // Basal multiplier: Use lowest (most conservative)
    if (effects.basalMultiplier !== undefined) {
      composed.basalMultiplier = Math.min(
        composed.basalMultiplier,
        effects.basalMultiplier
      );
    }
    
    // Max basal ceiling: Use lowest
    if (effects.maxBasalCeiling !== undefined) {
      composed.maxBasalCeiling = Math.min(
        composed.maxBasalCeiling,
        effects.maxBasalCeiling
      );
    }
    
    // Sensitivity: Compound multiply
    if (effects.sensitivityMultiplier !== undefined) {
      composed.sensitivityMultiplier *= effects.sensitivityMultiplier;
    }
  }
  
  return composed;
}
```

### Scenario 3: Profile Switch During Active Override

**Situation:** Human switches profile while override is active.

**Resolution:** 
- Profile switch proceeds
- Override remains active
- PolicyComposition recalculated with new profile + existing override

```javascript
function handleProfileSwitch(newProfileSelection, activeOverrides) {
  // Profile switch always allowed at appropriate authority level
  emitEvent('profile.selection.changed', newProfileSelection);
  
  // Recalculate composition with new profile and existing overrides
  const composition = computePolicyComposition(
    newProfileSelection.selectedProfileId,
    activeOverrides
  );
  
  emitEvent('policy.composition.computed', composition);
  
  // Overrides remain active - their effects are relative to new profile
  return composition;
}
```

### Scenario 4: Agent Flip-Flop Prevention

**Situation:** Agent activates/deactivates same override repeatedly.

**Resolution:** Rate limiting and cooldown periods.

```javascript
const FLIP_FLOP_CONFIG = {
  maxActivationsPerHour: 4,
  cooldownAfterEnd: 15 * 60, // 15 minutes in seconds
  requireConfirmationAfter: 2  // After 2 activations, require human confirmation
};

function checkFlipFlopLimits(agentId, overrideType) {
  const recentActivations = getRecentActivations(agentId, overrideType, 3600);
  
  if (recentActivations.length >= FLIP_FLOP_CONFIG.maxActivationsPerHour) {
    return {
      allowed: false,
      reason: 'rate_limit_exceeded',
      retryAfter: calculateRetryTime(recentActivations)
    };
  }
  
  const lastEnd = getLastOverrideEnd(agentId, overrideType);
  if (lastEnd) {
    const cooldownRemaining = FLIP_FLOP_CONFIG.cooldownAfterEnd - 
      (Date.now() - lastEnd) / 1000;
    
    if (cooldownRemaining > 0) {
      return {
        allowed: false,
        reason: 'cooldown_active',
        retryAfter: cooldownRemaining
      };
    }
  }
  
  if (recentActivations.length >= FLIP_FLOP_CONFIG.requireConfirmationAfter) {
    return {
      allowed: 'pending_confirmation',
      reason: 'requires_human_confirmation',
      confirmationRequest: createConfirmationRequest(agentId, overrideType)
    };
  }
  
  return { allowed: true };
}
```

### Scenario 5: Controller vs. Human Override Interaction

**Situation:** Human has active override; controller tries to adjust.

**Resolution:** Controller respects human override; can only work within its bounds.

```javascript
function controllerCanAdjust(controllerRequest, activeHumanOverride) {
  // Controller cannot:
  // - End human-initiated override
  // - Exceed limits set by human override
  // - Change target outside human-set range
  
  if (activeHumanOverride) {
    // Controller works within bounds
    return {
      allowed: true,
      constraints: {
        maxBasal: Math.min(
          controllerRequest.maxBasal,
          activeHumanOverride.effectiveEffects.maxBasalCeiling || Infinity
        ),
        targetRange: activeHumanOverride.effectiveEffects.targetRange,
        // Controller can micro-adjust within these bounds
        canAdjustBasal: true,
        canBolus: true
      }
    };
  }
  
  return { allowed: true, constraints: null };
}
```

---

## Concurrency Control

### Optimistic Locking

For updates to existing objects:

```javascript
async function updateWithOptimisticLock(collection, id, update, expectedVersion) {
  const result = await db.collection(collection).findOneAndUpdate(
    { 
      _id: id, 
      srvModified: expectedVersion 
    },
    { 
      $set: update,
      $inc: { version: 1 }
    },
    { returnDocument: 'after' }
  );
  
  if (!result.value) {
    throw new ConflictError('Version mismatch - document was modified');
  }
  
  return result.value;
}
```

### Event Ordering

All events receive a monotonic cursor for global ordering:

```javascript
async function assignEventCursor(event) {
  // Atomic increment of global cursor
  const counter = await db.collection('eventCursors').findOneAndUpdate(
    { _id: 'global' },
    { $inc: { cursor: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  
  event.cursor = counter.value.cursor;
  return event;
}
```

---

## Audit Trail

### Conflict Events

When conflicts are detected and resolved, emit audit events:

```javascript
function emitConflictResolution(conflict) {
  return {
    eventType: 'conflict.resolved',
    payload: {
      conflictId: generateUUID(),
      conflictType: conflict.type,
      participants: conflict.participants.map(p => ({
        issuerId: p.issuerId,
        issuerType: p.issuerType,
        authority: p.authority,
        action: p.action,
        timestamp: p.timestamp
      })),
      resolution: {
        outcome: conflict.resolution.outcome,
        winner: conflict.resolution.winner,
        reason: conflict.resolution.reason,
        appliedAt: new Date().toISOString()
      }
    }
  };
}
```

### Authority Escalation

When lower authority is blocked:

```javascript
function emitAuthorityBlock(request, blocker) {
  return {
    eventType: 'authority.blocked',
    payload: {
      requestedAction: request.action,
      requestedBy: request.issuer,
      requestedAuthority: request.authority,
      blockedBy: blocker.instanceId,
      blockerAuthority: blocker.authority,
      reason: 'insufficient_authority',
      requiredAuthority: blocker.authority,
      timestamp: new Date().toISOString()
    }
  };
}
```

---

## Delegation Grants

### Grant Structure

```javascript
const delegationGrant = {
  grantId: 'uuid',
  grantedBy: 'human-user-id',
  grantedTo: 'agent-id',
  
  scopes: [
    'override.activate:exercise',
    'override.activate:sleep',
    'override.suggest:*'
  ],
  
  constraints: {
    maxOverrideDuration: 4 * 3600, // 4 hours max
    allowedOverrideTypes: ['exercise', 'sleep', 'preMeal'],
    requireConfirmation: false,
    maxActivationsPerDay: 6,
    validTimeWindows: [
      { start: '06:00', end: '22:00' } // Only during waking hours
    ]
  },
  
  grantedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-12-31T23:59:59Z',
  revokedAt: null
};
```

### Grant Validation

```javascript
function validateDelegation(action, agent, grants) {
  const applicableGrants = grants.filter(g => 
    g.grantedTo === agent.issuerId &&
    !g.revokedAt &&
    new Date() < new Date(g.expiresAt)
  );
  
  for (const grant of applicableGrants) {
    if (!scopeMatches(action, grant.scopes)) continue;
    if (!withinConstraints(action, grant.constraints)) continue;
    if (!withinTimeWindow(grant.constraints.validTimeWindows)) continue;
    
    return { 
      valid: true, 
      grantId: grant.grantId,
      effectiveAuthority: 'delegated'
    };
  }
  
  return {
    valid: false,
    reason: 'no_valid_delegation',
    availableGrants: applicableGrants.length
  };
}
```

---

## Safety Invariants

### Never Violated

1. **Human always wins** — Human-initiated action cannot be blocked by lower authority
2. **Safety limits respected** — Composed effects never exceed safety limits
3. **Conservative composition** — When in doubt, choose the safer option
4. **Audit everything** — All conflict resolutions are logged
5. **Explicit revocation** — Delegations must be explicitly revoked

### Validated on Every Write

```javascript
function validateSafetyInvariants(proposedState) {
  const checks = [
    checkTargetRangeValid(proposedState.effectiveTarget),
    checkBasalWithinLimits(proposedState.effectiveBasal),
    checkIOBWithinLimits(proposedState.currentIOB),
    checkNoConflictingOverrides(proposedState.activeOverrides),
    checkAuthorityHierarchy(proposedState.recentActions)
  ];
  
  const violations = checks.filter(c => !c.valid);
  
  if (violations.length > 0) {
    throw new SafetyViolationError(violations);
  }
  
  return true;
}
```

---

## Configuration

```javascript
const CONFLICT_RESOLUTION_CONFIG = {
  // Authority levels
  authorityLevels: {
    'human-primary': 100,
    'human-caregiver': 80,
    'agent': 50,
    'controller': 30,
    'system': 10
  },
  
  // Composition strategy
  compositionStrategy: 'conservative', // or 'permissive'
  
  // Rate limiting
  rateLimits: {
    agent: {
      overrideActivationsPerHour: 4,
      profileSwitchesPerDay: 6
    },
    controller: {
      // Controllers are not rate-limited (they self-regulate)
    }
  },
  
  // Cooldowns
  cooldowns: {
    overrideReactivation: 900, // 15 minutes
    profileSwitch: 300 // 5 minutes
  },
  
  // Confirmation requirements
  confirmationRequired: {
    agentAfterNActivations: 2,
    highRiskActions: ['override.illness', 'profile.switch']
  }
};
```
