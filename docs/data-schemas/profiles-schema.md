# Profiles Schema Documentation

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Active (2025 Standard)  
**Source:** Code analysis and domain expert interview

---

## Overview

The `profile` collection stores therapy settings that define how the system calculates insulin dosing, carb ratios, target ranges, and basal rates. Profiles can change over time (e.g., different settings for weekdays vs weekends) and can be switched dynamically via Profile Switch treatments.

**Collection Name:** `profile`  
**Primary Timestamp Field:** `startDate` (ISO 8601)  
**Display/Query Field:** `mills` (computed from `startDate`)

---

## Document Structure Overview

A profile document has this high-level structure:

```javascript
{
  "_id": ObjectId,           // MongoDB primary key
  "defaultProfile": "Name",   // Which profile in store to use by default
  "startDate": "ISO-8601",   // When this profile record becomes active
  "mills": Number,           // Computed: new Date(startDate).getTime()
  "enteredBy": "String",     // Who created this profile
  "units": "mg/dL",          // Default units for the whole document
  
  "store": {                 // Named profile definitions
    "ProfileName": { /* profile settings */ },
    "Weekend": { /* alternative profile */ }
  },
  
  // Loop-specific (optional)
  "loopSettings": { /* controller settings */ }
}
```

---

## Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | ObjectId | Yes (auto) | MongoDB primary key |
| `defaultProfile` | String | Yes | Name of the default profile within `store` |
| `startDate` | String (ISO 8601) | Yes | When this profile document becomes active |
| `mills` | Number | Computed | Milliseconds since epoch, computed from `startDate` |
| `enteredBy` | String | No | Who created this profile (e.g., "Loop", "AAPS") |
| `units` | String | No | Default unit system (`mg/dL` or `mmol/L`) |

### Legacy Profile Conversion

Older profiles may not have a `store` structure. The system auto-converts them:

```javascript
// lib/profilefunctions.js:35-56
if (!profile.defaultProfile) {
  newObject.defaultProfile = 'Default';
  newObject.store = {};
  newObject.store['Default'] = profile;  // Old profile becomes "Default"
  newObject.convertedOnTheFly = true;
}
```

The `convertedOnTheFly` flag indicates this conversion happened.

---

## Profile Store Structure

The `store` object contains named profiles. Each profile has settings that can vary by time of day.

### Individual Profile Fields

| Field | Type | Format | Description |
|-------|------|--------|-------------|
| `units` | String | `mg/dL` or `mmol/L` | Unit system for this profile |
| `dia` | Number | Hours | Duration of Insulin Action (typically 3-6 hours) |
| `timezone` | String | IANA/Olson | Timezone for time-based values (e.g., `US/Eastern`, `Europe/London`) |
| `carbs_hr` | Number or String | g/hr | Carbohydrate absorption rate |
| `delay` | Number or String | Minutes | Delay before insulin activity starts |
| `basal` | Array | Time-value pairs | Basal insulin rates by time of day |
| `carbratio` | Array | Time-value pairs | Insulin-to-carb ratios by time of day |
| `sens` | Array | Time-value pairs | Insulin sensitivity factors by time of day |
| `target_low` | Array | Time-value pairs | Low end of target glucose range |
| `target_high` | Array | Time-value pairs | High end of target glucose range |

### Time-Value Pair Format

Arrays like `basal`, `carbratio`, `sens`, `target_low`, `target_high` use this structure:

```javascript
{
  "time": "HH:MM",        // 24-hour format, e.g., "05:30"
  "timeAsSeconds": 19800,  // Seconds from midnight (computed)
  "value": 1.7             // The setting value at this time
}
```

**Note:** `timeAsSeconds` is computed during profile load by `preprocessProfileOnLoad()`:
```javascript
// lib/profilefunctions.js:74-77
if (value.time) {
  var sec = profile.timeStringToSeconds(value.time);
  if (!isNaN(sec)) { value.timeAsSeconds = sec; }
}
```

### Example Profile Store

```javascript
"store": {
  "Default": {
    "units": "mg/dL",
    "dia": 6,
    "timezone": "ETC/GMT+8",
    "carbs_hr": "0",
    "delay": "0",
    "basal": [
      { "time": "00:00", "timeAsSeconds": 0, "value": 1.8 },
      { "time": "05:30", "timeAsSeconds": 19800, "value": 1.7 },
      { "time": "22:30", "timeAsSeconds": 81000, "value": 1.8 }
    ],
    "carbratio": [
      { "time": "00:00", "timeAsSeconds": 0, "value": 10 }
    ],
    "sens": [
      { "time": "00:00", "timeAsSeconds": 0, "value": 40 }
    ],
    "target_low": [
      { "time": "00:00", "timeAsSeconds": 0, "value": 97 }
    ],
    "target_high": [
      { "time": "00:00", "timeAsSeconds": 0, "value": 102 }
    ]
  }
}
```

---

## Loop-Specific Fields

When profiles are uploaded by Loop (iOS), they include additional controller settings.

### `loopSettings` Object

| Field | Type | Description |
|-------|------|-------------|
| `maximumBasalRatePerHour` | Number | Max basal rate the loop can set (U/hr) |
| `maximumBolus` | Number | Max bolus the loop can recommend (U) |
| `dosingStrategy` | String | How Loop doses: `tempBasalOnly`, `automaticBolus` |
| `dosingEnabled` | Boolean | Whether closed-loop dosing is active |
| `minimumBGGuard` | Number | Glucose level that triggers suspend (safety) |
| `deviceToken` | String | Push notification token |
| `bundleIdentifier` | String | iOS app identifier |
| `preMealTargetRange` | Array[2] | Target range for pre-meal mode `[low, high]` |
| `overridePresets` | Array | Predefined override configurations |

### Override Presets

Override presets allow quick activation of temporary settings (e.g., for exercise, sick days).

```javascript
"overridePresets": [
  {
    "name": "sleepin",
    "symbol": "🤸‍♀️",           // Emoji for UI display
    "duration": 3600,          // Duration in seconds
    "targetRange": [120, 125], // Temporary target [low, high]
    "insulinNeedsScaleFactor": 0.5  // 50% less insulin sensitivity
  },
  {
    "name": "basketball",
    "symbol": "⛹️‍♂️",
    "duration": 5400,
    "targetRange": [165, 180],
    "insulinNeedsScaleFactor": 0.7
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Display name for the override |
| `symbol` | String | Emoji icon for UI |
| `duration` | Number | How long the override lasts (seconds) |
| `targetRange` | Array[2] | `[low, high]` glucose target |
| `insulinNeedsScaleFactor` | Number | Multiplier for insulin needs (< 1 = less insulin) |

---

## Profile Switching (via Treatments)

Profiles can be switched dynamically using a treatment with `eventType: "Profile Switch"`.

### Profile Switch Treatment Fields

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | String | Must be `"Profile Switch"` |
| `profile` | String | Name of profile to switch to (must exist in `store`) |
| `duration` | Number | How long to use this profile (0 = indefinite) |
| `profileJson` | String (JSON) | Optional: Embedded profile definition |

### Embedded Profile (AAPS Pattern)

AAPS can embed a complete profile definition in `profileJson`:

```javascript
{
  "eventType": "Profile Switch",
  "profile": "Temp Profile",
  "profileJson": "{\"dia\": 5, \"basal\": [...], ...}",
  "duration": 0
}
```

When processed, the embedded JSON is injected into the store with a disambiguated name:
```javascript
// lib/profilefunctions.js:272-276
if (treatment.profileJson && !pdataActive.store[treatment.profile]) {
  if (treatment.profile.indexOf("@@@@@") < 0)
    treatment.profile += "@@@@@" + treatment.mills;
  let json = JSON.parse(treatment.profileJson);
  pdataActive.store[treatment.profile] = json;
}
```

The `@@@@@` separator prevents name collisions between embedded profiles.

---

## Circadian Percentage Profile (CPP)

Some treatments support percentage-based profile modifications:

| Field | Type | Description |
|-------|------|-------------|
| `CircadianPercentageProfile` | Boolean | Enables CPP mode |
| `percentage` | Number | Multiplier for basal/sensitivity (100 = normal) |
| `timeshift` | Number | Hours to shift the profile schedule |

When active, CPP modifies values:
- `sens` and `carbratio`: Divided by (percentage / 100)
- `basal`: Multiplied by (percentage / 100)

---

## Real-World Loop Profile Document

From domain expert interview (Loop/iOS):

```javascript
{
  "_id": "6966f0e8eea0a066ad267c9a",
  "defaultProfile": "Default",
  "startDate": "2026-01-14T01:26:25Z",
  "enteredBy": "Loop",
  "units": "mg/dL",
  "mills": "1768353985117",
  
  "loopSettings": {
    "maximumBasalRatePerHour": 6,
    "maximumBolus": 9.9,
    "dosingStrategy": "tempBasalOnly",
    "dosingEnabled": true,
    "minimumBGGuard": 69,
    "preMealTargetRange": [69, 69],
    "deviceToken": "24087ffec20913af...",
    "bundleIdentifier": "com.medicaldatanetworks.loop-denim.Loop",
    "overridePresets": [
      { "name": "sleepin", "symbol": "🤸‍♀️", "duration": 3600,
        "targetRange": [120, 125], "insulinNeedsScaleFactor": 0.5 },
      { "name": "horse", "symbol": "🚵‍♂️", "duration": 10800,
        "targetRange": [135, 136], "insulinNeedsScaleFactor": 1.5 },
      { "name": "basketball", "symbol": "⛹️‍♂️", "duration": 5400,
        "targetRange": [165, 180], "insulinNeedsScaleFactor": 0.7 }
    ]
  },
  
  "store": {
    "Default": {
      "units": "mg/dL",
      "dia": 6,
      "timezone": "ETC/GMT+8",
      "carbs_hr": "0",
      "delay": "0",
      "basal": [
        { "time": "00:00", "timeAsSeconds": 0, "value": 1.8 },
        { "time": "05:30", "value": 1.7, "timeAsSeconds": 19800 },
        { "time": "22:30", "timeAsSeconds": 81000, "value": 1.8 }
      ],
      "carbratio": [
        { "time": "00:00", "value": 10, "timeAsSeconds": 0 }
      ],
      "sens": [
        { "timeAsSeconds": 0, "time": "00:00", "value": 40 }
      ],
      "target_low": [
        { "value": 97, "time": "00:00", "timeAsSeconds": 0 }
      ],
      "target_high": [
        { "timeAsSeconds": 0, "time": "00:00", "value": 102 }
      ]
    }
  }
}
```

---

## Timezone Handling

### Known Issue: Loop Timezone Format

Loop uploads non-standard timezone strings:
```javascript
// lib/profilefunctions.js:179-181
// Work around Loop uploading non-ISO compliant time zone string
if (rVal) rVal.replace('ETC','Etc');
```

Example: Loop sends `ETC/GMT+8` but the standard is `Etc/GMT+8`.

### Missing Timezone

If no timezone is specified, the system falls back to the server's local time, which can cause incorrect time-of-day lookups. This is documented as a TODO:

```javascript
// lib/profilefunctions.js:107-110
// Use local time zone if profile doesn't contain a time zone
// This WILL break on the server; added warnings elsewhere that this is missing
// TODO: Better warnings to user for missing configuration
```

---

## Known Bugs and Quirks

### Override Display Issues

**Symptom:** Override events (Temporary Targets, exercise modes):
- Sometimes appear indefinite when they should have a duration
- Cannot be ended or cancelled through the UI
- Don't render at all in some views

**Root Cause:** Unclear - may be related to how duration is interpreted or event ordering.

### Profile Name Collision

When AAPS sends embedded profiles via `profileJson`, the system adds `@@@@@` + timestamp to disambiguate:
```javascript
treatment.profile += "@@@@@" + treatment.mills;
```

This is a workaround, not a proper namespace solution. Profile names containing `@@@@@` could theoretically conflict.

### Legacy Profile Detection

The system checks for `defaultProfile` to determine if conversion is needed:
```javascript
if (!profile.defaultProfile) { /* convert */ }
```

A profile with `defaultProfile: ""` (empty string) might be incorrectly treated as modern format.

---

## Units Handling

### Best Practice: Units in Shape

The domain expert noted that best practice is to **encode units in the type/shape of data**, not just store numeric values with a separate units field.

Current approach:
```javascript
{
  "target_low": [{ "value": 97 }],  // Is this mg/dL or mmol?
  "units": "mg/dL"                   // Stored separately
}
```

Potential improvement:
```javascript
{
  "target_low": [{ "value_mgdl": 97, "value_mmol": 5.4 }]  // Both provided
}
```

### Environment-Based Display

Users set their preferred display units via environment variables. The stored value is typically in one canonical unit (often mg/dL), and the client converts for display.

---

## API Access

### Swagger Definition (Incomplete)

The swagger.yaml defines Profile minimally:
```yaml
Profile:
  properties:
    sens:
      type: integer
    dia:
      type: integer
    carbratio:
      type: integer
    carbs_hr:
      type: integer
    _id:
      type: string
```

This is incomplete - it doesn't reflect the actual nested `store` structure or time-value arrays.

---

## Lessons Learned

### Schema Discovery Process

1. **Real data is invaluable** - The Loop profile document from the domain expert revealed fields not documented anywhere else (like `loopSettings`, `overridePresets`, emoji `symbol`)

2. **Multiple profile formats coexist** - Legacy flat profiles vs. modern store-based profiles vs. Loop-enhanced profiles all exist in production

3. **Controller-specific extensions** - Loop adds `loopSettings`, AAPS adds `profileJson` in treatments - there's no unified extension mechanism

### Open Questions

1. **Should profiles have versions?** No version field exists, making migrations hard
2. **How to validate profile correctness?** No schema validation - invalid profiles may cause silent failures
3. **What's the interaction between profile store and temp profiles?** The `@@@@@` separator is a hack

### Barriers Encountered

- Swagger definition is woefully incomplete
- Timezone handling quirks required reading workaround comments in code
- Loop-specific fields only discoverable from real device uploads
- No formal documentation exists for override presets structure

---

## Source References

| File | Purpose |
|------|---------|
| `lib/profilefunctions.js` | Profile loading, caching, value lookup |
| `lib/report_plugins/profiles.js` | Profile report UI (reveals field usage) |
| `lib/profile/profileeditor.js` | Profile editing logic |
| `lib/server/swagger.yaml` | API documentation (incomplete) |

---

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-15 | Agent | Initial schema documentation from code analysis and domain expert interview |
