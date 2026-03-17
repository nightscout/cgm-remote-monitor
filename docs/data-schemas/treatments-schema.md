# Treatments Schema Documentation

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Active (2025 Standard)  
**Source:** Code analysis and domain expert interview

---

## Overview

The `treatments` collection stores all user interventions and system events related to diabetes management. This includes insulin doses, carbohydrate intake, temp basals, profile switches, CGM sensor events, and free-form notes.

**Collection Name:** `treatments`  
**Primary Timestamp Field:** `created_at` (ISO 8601)  
**Display/Query Field:** `mills` (computed from `created_at`)

---

## Core Fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `_id` | ObjectId | Yes (auto) | MongoDB ObjectId | Primary key, auto-generated |
| `eventType` | String | Yes* | Defaults to `<none>` if missing | Classification of the treatment type |
| `created_at` | String (ISO 8601) | Yes | Valid ISO timestamp | When the event was observed/occurred (NOT upload time) |
| `mills` | Number | Computed | `new Date(created_at).getTime()` | Milliseconds since epoch, computed for queries |
| `enteredBy` | String | No | Free-form, max ~50 chars typical | Nickname of person/device that entered the record |
| `notes` | String | No | Free-form text | Additional notes or comments |
| `units` | String | No | `mg/dL` or `mmol/L` | Unit system for glucose values in this record |

*Note: If `eventType` is missing, the websocket layer defaults it to `<none>` (see `lib/server/websocket.js:357-358`).

---

## Glucose Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `glucose` | Number | Optional | Blood glucose value at time of treatment |
| `glucoseType` | String | `Sensor`, `Finger`, or `Manual` | Method used to obtain the glucose reading |

---

## Nutrition Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `carbs` | Number | ≥ 0, in grams | Carbohydrates consumed |
| `protein` | Number | ≥ 0, in grams | Protein consumed |
| `fat` | Number | ≥ 0, in grams | Fat consumed |
| `foodType` | String | Optional | Description of food eaten |
| `absorptionTime` | Number | Optional, in minutes | Expected absorption time for carbs |
| `preBolus` | Number | Optional, in minutes | Time offset between insulin and meal |

---

## Insulin Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `insulin` | Number | ≥ 0, in units | Amount of insulin administered |
| `splitNow` | Number | 0-100, percentage | For Combo Bolus: immediate portion |
| `splitExt` | Number | 0-100, percentage | For Combo Bolus: extended portion |

---

## Basal Modification Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `duration` | Number | ≥ 0, in minutes | How long the temp basal or override lasts |
| `percent` | Number | Can be negative | Basal change as percentage (e.g., -50 for 50% reduction) |
| `absolute` | Number | ≥ 0, U/hr | Absolute basal rate override |

**Note:** `percent` and `absolute` are mutually exclusive for temp basals.

---

## Temporary Target Fields (from Loop/OpenAPS)

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `targetTop` | Number | In user's units | Upper bound of temporary target range |
| `targetBottom` | Number | In user's units | Lower bound of temporary target range |
| `correctionRange` | Array[2] | `[min, max]` | Alternative format for target range |
| `reason` | String | Optional | Reason for temporary target (e.g., "Eating Soon", "Activity") |
| `insulinNeedsScaleFactor` | Number | Multiplier | Adjustment factor for insulin sensitivity |

---

## Profile Switch Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `profile` | String | Profile name | Name of the profile being switched to |

**Note:** The `profile` field is a string name reference, not a foreign key. If the named profile doesn't exist, behavior is undefined.

---

## Sensor Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `sensorCode` | String | Optional | Sensor identification code |
| `transmitterId` | String | Optional | CGM transmitter ID |

---

## Sync/Reconciliation Fields

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `srvCreated` | String (ISO 8601) | Server | When the server first received this record |
| `srvModified` | String (ISO 8601) | Server | When the server last modified this record |
| `identifier` | String | Server/Client | Unified sync identity (see below) |
| `syncIdentifier` | String | Loop | Loop carbs/doses sync identity (preserved, not copied) |
| `uuid` | String | xDrip+ | xDrip+ sync identity (preserved, not copied) |
| `pumpId` | String | Loop/pumps | Pump-assigned identifier |
| `pumpType` | String | Loop/pumps | Type of pump that created this treatment |
| `pumpSerial` | String | Loop/pumps | Serial number of the pump |

### Identifier Field Normalization (REQ-SYNC-072)

As of v15.0.7, the server normalizes **UUID values in the `_id` field** when `UUID_HANDLING=true` (default):

| Client | Client Field | UUID_HANDLING=true | UUID_HANDLING=false |
|--------|--------------|---------------------|----------------------|
| **Loop** (overrides) | UUID in `_id` | Move to `identifier`, assign ObjectId | Strip `_id`, assign ObjectId (UUID not preserved) |
| **Loop** (carbs/doses) | `syncIdentifier` | Preserved as-is | Preserved as-is |
| **AAPS** | `identifier` | Unchanged (already correct) | Unchanged (already correct) |
| **xDrip+** | `uuid` | Preserved as-is | Preserved as-is |

**Scope:** Only UUID values in the `_id` field are affected. Other client identity fields (`syncIdentifier`, `uuid`) are preserved but NOT copied to `identifier`.

**UUID_HANDLING controls both write-path normalization and read-path queries** (GET/DELETE by UUID `_id`).

**Deduplication Priority:** The server uses `identifier` or `_id` for upsert matching when present, falling back to `created_at + eventType` for legacy records.

**Example - Loop Override Upload (UUID_HANDLING=true):**

```javascript
// Client sends:
{ "_id": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "eventType": "Temporary Override", ... }

// Server stores:
{ "_id": ObjectId("..."), "identifier": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "eventType": "Temporary Override", ... }
```

**Note:** Loop carbs/doses (which use `syncIdentifier`) rely on Loop's local ObjectIdCache for dedup, not server-side logic.

---

## Event Types

### Core Event Types (from `lib/plugins/careportal.js`)

| eventType Value | Display Name | Key Fields Used |
|-----------------|--------------|-----------------|
| `<none>` | (none) | bg, insulin, carbs |
| `BG Check` | BG Check | bg |
| `Snack Bolus` | Snack Bolus | bg, insulin, carbs, protein, fat, prebolus |
| `Meal Bolus` | Meal Bolus | bg, insulin, carbs, protein, fat, prebolus |
| `Correction Bolus` | Correction Bolus | bg, insulin |
| `Carb Correction` | Carb Correction | bg, carbs, protein, fat |
| `Combo Bolus` | Combo Bolus | bg, insulin, carbs, duration, split |
| `Announcement` | Announcement | bg |
| `Note` | Note | bg, duration |
| `Question` | Question | bg |
| `Exercise` | Exercise | duration |
| `Site Change` | Pump Site Change | bg, insulin |
| `Sensor Start` | CGM Sensor Start | bg, sensor |
| `Sensor Change` | CGM Sensor Insert | bg, sensor |
| `Sensor Stop` | CGM Sensor Stop | bg |
| `Pump Battery Change` | Pump Battery Change | bg |
| `Insulin Change` | Insulin Cartridge Change | bg |
| `Temp Basal Start` | Temp Basal Start | bg, duration, percent, absolute |
| `Temp Basal End` | Temp Basal End | bg, duration |
| `Profile Switch` | Profile Switch | bg, duration, profile |
| `D.A.D. Alert` | D.A.D. Alert | bg |

### OpenAPS/AAPS Event Types (from `lib/plugins/openaps.js`)

| eventType Value | Description |
|-----------------|-------------|
| `Temporary Target` | Sets a temporary target range with duration |
| `Temporary Target Cancel` | Cancels an active temporary target |
| `OpenAPS Offline` | Indicates loop is offline for specified duration |

### Loop Event Types (from `lib/plugins/loop.js`)

Loop uses similar event types to the core set, plus controller-specific extensions.

### Controller-Specific Event Types

Custom closed-loop systems (AAPS, Loop, Trio, oref0) may send additional event types. These are not enumerated here and may include:
- SMB (Super Micro Bolus) records
- Autosens data
- Override presets
- Algorithm-specific annotations

**Note:** The `eventType` field is essentially free-form - clients can send any string value. The UI treats unknown types gracefully but may not render them optimally.

---

## Timestamp Semantics

### `created_at` vs `srvCreated`

| Field | Meaning | Set By |
|-------|---------|--------|
| `created_at` | When the event was **observed/happened** | Client or Server |
| `srvCreated` | When the server **first received** this record | Server only |

**Use Case:** AAPS uses `srvCreated` for cache control during its update/reconcile sync loop. This allows distinguishing between "this insulin was given at 8am" (`created_at`) vs "we learned about it at 8:15am" (`srvCreated`).

### Missing `created_at`

If a treatment arrives without `created_at`, the server sets it to the current time:
```javascript
// lib/server/websocket.js:360-361
if (!('created_at' in data.data)) {
  data.data.created_at = new Date().toISOString();
}
```

---

## `enteredBy` Field Behavior

The `enteredBy` field is a **free-form nickname** with the following characteristics:

1. **Browser Auto-fill:** The web UI prefills this field with the last value entered on that device
2. **Not Identity-Verified:** This is an optimistic field - there's no authentication tied to it
3. **Use Cases:** Helpful for families where multiple people (e.g., "Mom", "Dad", "Nurse") enter treatments
4. **Future Consideration:** Real identity tracking may be needed for audit trails, but currently this is just a convenience field

---

## Known Bugs and Quirks

### AAPS Basal Slice Display Issue

**Symptom:** Some temp basal slices disappear in the Nightscout UI when uploaded from AAPS.

**Status:** Possible PR exists to address this. Needs investigation.

**Workaround:** None documented.

### Override Duration Issues

**Symptom:** Override events (like temporary targets) sometimes:
- Appear indefinite when they should have ended
- Cannot be ended or cancelled through the UI
- Don't render at all

**Status:** Active bug, cause unclear.

### Temp Basal Rendering

The code filters out `Temp Basal` from some event type dropdowns:
```javascript
// lib/report_plugins/treatments.js:176-178
if (event.name.indexOf('Temp Basal') > -1) {
  return;
}
```
Then adds it back manually. This suggests special handling is needed for temp basals that may cause edge cases.

---

## Client Compatibility Notes

### AAPS (AndroidAPS)
- Uses `identifier` field for sync deduplication
- Relies heavily on `srvCreated` for cache control
- May send SMB-specific event types

### Loop (iOS)
- Uses pump-related fields (`pumpId`, `pumpType`, `pumpSerial`) for identification
- Sends override presets with emoji symbols
- Profile documents include `loopSettings` object

### xDrip+
- Uses `uuid` field for sync
- May send BG checks and calibrations

### Trio
- Fork of Loop with similar patterns
- May have additional event types

---

## Other Observed Fields

The following fields have been observed in treatment records but are less commonly used or controller-specific. This list is **not exhaustive** - custom controllers can add any fields they need.

| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `utcOffset` | Number | UTC offset in minutes for the client timezone | Various clients |
| `durationInMillis` | Number | Alternative to `duration` in milliseconds | Some pumps |
| `insulinInjections` | Array | Detailed injection records from some pumps | Pump-specific |
| `splitNow` / `splitExt` | Number | Combo bolus split percentages | Careportal |
| `targetBottom` / `targetTop` | Number | Alternative naming for target range bounds | Some clients |
| `timestamp` | String | Alternative to `created_at` in some contexts | Legacy |
| `isAnnouncement` | Boolean | Flags announcement type | Some clients |
| `pumpId`, `pumpType`, `pumpSerial` | String | Pump identification for deduplication | Loop/pumps |

**Note on glucoseType:** Beyond `Sensor`, `Finger`, and `Manual`, some clients may send other values. The core system treats these as display strings without validation.

---

## Server-Side Defaults Scope

The defaults documented (eventType defaulting to `<none>`, created_at defaulting to current time) are applied in **WebSocket ingestion** (`lib/server/websocket.js`). The REST API v1 treatment endpoint (`lib/server/treatments.js`) may have different or no defaults - always verify behavior for your ingestion path.

---

## Validation Constraints Summary

| Constraint | Fields Affected | Enforcement |
|------------|----------------|-------------|
| Non-negative | `carbs`, `protein`, `fat`, `insulin`, `duration`, `absolute` | UI `min="0"` |
| Step increments | `insulin` (0.05), `percent` (10), `duration` (1) | UI `step` attribute |
| Mutually exclusive | `percent` vs `absolute` | UI hides one when other has value |
| Required | `eventType` (defaulted), `created_at` (defaulted) | Server-side fallback |

**Note:** Server-side validation is minimal. Most constraints are UI-enforced only.

---

## Lessons Learned

### Schema Discovery Process

1. **Report plugins are schema documentation** - The treatments report plugin (`lib/report_plugins/treatments.js`) reveals which fields are actually used and displayed
2. **Event types come from plugins** - The `getAllEventTypes()` function aggregates types from enabled plugins, making the canonical list dynamic
3. **Sync identity is client-dependent** - Each controller (AAPS, Loop, xDrip) uses different fields for duplicate detection, complicating server-side deduplication

### Open Questions

1. **Should eventType be enumerated?** Currently free-form, but validation could catch typos
2. **Should sync identity be standardized?** A single `clientId` or `uuid` field could simplify reconciliation
3. **Are field constraints documented anywhere?** The UI has min/max but there's no schema validation layer

### Barriers Encountered

- No formal schema file exists - had to extract from code
- Event types are scattered across multiple plugin files
- Some fields (like `identifier`) are undocumented and discovered by reading AAPS source

---

## Source References

| File | Purpose |
|------|---------|
| `lib/server/treatments.js` | Server-side treatment CRUD operations |
| `lib/server/websocket.js` | Real-time treatment insertion |
| `lib/plugins/careportal.js` | Core event type definitions |
| `lib/plugins/openaps.js` | OpenAPS-specific event types |
| `lib/plugins/loop.js` | Loop-specific event types |
| `lib/report_plugins/treatments.js` | Treatment report (reveals field usage) |
| `lib/data/ddata.js` | Treatment data processing |
| `lib/client/careportal.js` | Client-side treatment entry UI |
| `lib/server/swagger.yaml` | API documentation (partial schema) |

---

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-03-17 | Agent | Added identifier field normalization (REQ-SYNC-072) |
| 2026-01-15 | Agent | Initial schema documentation from code analysis and domain expert interview |
