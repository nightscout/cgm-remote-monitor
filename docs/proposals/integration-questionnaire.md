# Integration Questionnaire for Loop/AAPS/Trio Implementers

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Draft (2026 Proposal)  
**Related:** [Agent Control Plane RFC](./agent-control-plane-rfc.md), [Bridge Rules](./bridge-rules.md)

---

## Purpose

This questionnaire helps determine how well existing AID controllers can support the proposed event-driven control plane architecture. Answers will inform bridge mode implementation and native event adoption roadmaps.

---

## A) Profiles & Overrides Semantics

### A1. Profile Identification
**Question:** Do you have stable identifiers for a profile (beyond just the name)?

| Controller | Current State | Can Emit Content Hash? |
|------------|--------------|----------------------|
| Loop | | |
| Trio | | |
| AAPS | | |
| OpenAPS | | |

**Follow-up:** If not stable IDs, can you emit a content hash of the profile?

---

### A2. Override Templates vs. Activations
**Question:** Can you represent overrides as separate concepts?
- **Template/Definition:** The reusable preset (e.g., "Exercise mode - 140 target, 70% basal")
- **Instance/Activation:** A concrete use of that template

| Controller | Has Templates? | Templates Persisted? | Can Separate? |
|------------|---------------|---------------------|---------------|
| Loop | | | |
| Trio | | | |
| AAPS | | | |

---

### A3. Override Dimensions
**Question:** What override adjustment dimensions exist in your controller?

| Dimension | Loop | Trio | AAPS | OpenAPS |
|-----------|------|------|------|---------|
| Target range (min/max) | | | | |
| Single target value | | | | |
| Sensitivity multiplier | | | | |
| Basal multiplier/percentage | | | | |
| Max basal ceiling | | | | |
| Carb ratio multiplier | | | | |
| Automation aggressiveness | | | | |
| Duration (fixed/indefinite) | | | | |

---

### A4. Multiple Override Resolution
**Question:** How do you resolve multiple concurrent overrides?

- [ ] Only one override can be active at a time
- [ ] Overrides stack/compose with precedence rules
- [ ] Most recent override wins
- [ ] User must explicitly end one before starting another
- [ ] Other: _____________

**Precedence rules (if applicable):**
```
Describe how conflicts are resolved...
```

---

## B) Policy Composition

### B5. Effective Parameters Computation
**Question:** Do you compute an explicit "effective therapy settings right now" object internally?

| Controller | Has Explicit Object? | Fields Included |
|------------|---------------------|-----------------|
| Loop | | |
| Trio | | |
| AAPS | | |

---

### B6. Composition Emission
**Question:** Can you emit a composition snapshot containing:

| Field | Loop | Trio | AAPS | Notes |
|-------|------|------|------|-------|
| Profile hash/ID | | | | |
| Active override IDs | | | | |
| Effective target range | | | | |
| Effective ISF (current) | | | | |
| Effective CR (current) | | | | |
| Effective basal (current) | | | | |
| Safety limits in force | | | | |
| Controller version/build | | | | |

**If "yes" to most fields:** Nightscout's digital twin becomes reliable without simulating the algorithm.

---

## C) Delivery Fidelity

### C7. Delivery State Distinction
**Question:** Can you distinguish clearly between:

| State | Loop | Trio | AAPS | Where Reported |
|-------|------|------|------|----------------|
| **Suggested/recommended** (algorithm output) | | | | |
| **Requested** (command sent to pump) | | | | |
| **Confirmed/enacted** (pump acknowledged) | | | | |

---

### C8. Pump Response Codes
**Question:** Do you have pump ACK/NAK/error codes that can be surfaced?

| Controller | Has Error Codes | Examples | Can Expose? |
|------------|----------------|----------|-------------|
| Loop | | | |
| Trio | | | |
| AAPS | | | |

---

### C9. Failure Reason Distinction
**Question:** How do you represent different failure modes?

| Failure Type | Loop | Trio | AAPS |
|-------------|------|------|------|
| Capped by max basal limit | | | |
| Capped by max IOB | | | |
| Communication failure with pump | | | |
| Pump busy/unavailable | | | |
| User canceled | | | |
| Pump error (occlusion, etc.) | | | |

**Current representation format:** (e.g., error codes, status strings, flags)
```
...
```

---

## D) Timing and Ordering

### D10. Monotonic Ordering
**Question:** Can you provide monotonic ordering per controller?

| Controller | Has Sequence Numbers | Clock Guarantees | Ordering Method |
|------------|---------------------|------------------|-----------------|
| Loop | | | |
| Trio | | | |
| AAPS | | | |

**If no sequence numbers:** What clock/timing guarantees exist?

---

### D11. Offline Batching
**Question:** How do you handle offline operation and delayed uploads?

| Scenario | Loop | Trio | AAPS |
|----------|------|------|------|
| Queue events when offline | | | |
| Batch upload on reconnect | | | |
| Preserve ordering in batch | | | |
| Mark events as "delayed" | | | |
| Dedup on retry | | | |

---

## E) Minimal Commitment for Phase 1

### E12. Smallest Native Event Set
**Question:** What is the smallest set of native events you're willing to emit first?

**Proposed minimal set for Phase 1:**

| Event | Priority | Loop | Trio | AAPS |
|-------|----------|------|------|------|
| `override.instance.activated` | High | | | |
| `override.instance.ended` | High | | | |
| `policy.composition.computed` | High | | | |
| `delivery.observed` (summary) | Medium | | | |
| `profile.selection.changed` | Medium | | | |
| `capability.snapshot.updated` | Low | | | |

**Your minimal commitment:**
```
List the events you can commit to emitting...
```

---

## F) Additional Capabilities

### F13. Remote Commands
**Question:** Can your controller accept commands from Nightscout?

| Command Type | Loop | Trio | AAPS | Security Model |
|-------------|------|------|------|----------------|
| Activate override | | | | |
| End override | | | | |
| Switch profile | | | | |
| Set temp target | | | | |
| Bolus (caregiving) | | | | |

---

### F14. Controller Registration
**Question:** Can you emit controller registration events?

| Field | Loop | Trio | AAPS |
|-------|------|------|------|
| Unique instance ID | | | |
| Device info | | | |
| Pump binding info | | | |
| CGM binding info | | | |
| Version/build | | | |

---

## G) Migration Path

### G15. Adoption Timeline
**Question:** What's your estimated timeline for native event emission?

| Phase | Loop | Trio | AAPS |
|-------|------|------|------|
| Can test in dev builds | | | |
| Can ship in beta | | | |
| Can ship in stable | | | |
| Full native (no devicestatus) | | | |

---

### G16. Bridge Mode Feedback
**Question:** What concerns do you have about Nightscout synthesizing events from your devicestatus uploads?

- [ ] Accuracy of override state extraction
- [ ] Accuracy of delivery extraction
- [ ] Missing fields in current devicestatus
- [ ] Timing/ordering issues
- [ ] Duplicate events
- [ ] Other: _____________

---

## How to Submit

Please fill out this questionnaire and submit via:

1. **GitHub Issue** on the Nightscout cgm-remote-monitor repository with label `agentic-control-plane`
2. **Pull Request** adding your controller's responses to this file
3. **Discord** in the #development channel

---

## Contact

Questions about this questionnaire:
- Nightscout Discord: [link]
- GitHub Discussions: [link]

---

## Responses

### Loop
*Status: Pending*

### Trio  
*Status: Pending*

### AAPS
*Status: Pending*

### OpenAPS
*Status: Pending*
