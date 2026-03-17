# Plugin Architecture Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** Plugin system design, extension points, Pebble integration, plugin inventory

---

## 1. Executive Summary

Nightscout's plugin system provides extensible data processing, visualization, and alerting capabilities. This audit documents the plugin architecture, available plugins, and modernization opportunities.

### Plugin System Overview

| Metric | Value |
|--------|-------|
| Total Plugins | 38 |
| Client Default Plugins | 24 |
| Server Default Plugins | 21 |
| Plugin Types | 6 |
| Extension Points | 5 |

---

## 2. Plugin Architecture

### 2.1 Plugin Base

**Location:** `lib/plugins/pluginbase.js`

All plugins inherit from a common base that provides:
- Access to translation system
- Access to moment.js for date handling
- Access to utility functions

### 2.2 Plugin Registration

**Location:** `lib/plugins/index.js`

**Registration Flow:**
```javascript
// During boot
ctx.plugins = require('../plugins')({
  settings: env.settings,
  language: ctx.language,
  levels: ctx.levels,
  moment: ctx.moment
}).registerServerDefaults();
```

**Client vs Server Plugins:**
- Server plugins: Run on Node.js, check notifications, server-side processing
- Client plugins: Run in browser, update visualizations, UI interactions

### 2.3 Plugin Context

Each plugin receives a context object (`ctx`) with:

| Property | Description |
|----------|-------------|
| `settings` | Application settings |
| `language` | Translation functions |
| `levels` | Alarm level definitions |
| `moment` | Date/time library |
| `notifications` | Notification system access |
| `ddata` | Current data snapshot |

---

## 3. Plugin Types

### 3.1 Primary Pills (`pill-primary`)

Display primary values in the main UI pill area.

| Plugin | Purpose |
|--------|---------|
| `bgnow` | Current blood glucose value |
| `rawbg` | Raw/unfiltered glucose value |

### 3.2 Status Pills (`pill-status`)

Display status indicators and secondary information.

| Plugin | Purpose |
|--------|---------|
| `timeago` | Time since last reading |
| `upbat` | Uploader battery status |
| `direction` | Glucose trend arrow |

### 3.3 Forecast Plugins (`forecast`)

Provide predictions and trend analysis.

| Plugin | Purpose |
|--------|---------|
| `ar2` | Auto-regressive prediction |
| `loop` | Loop system predictions |
| `openaps` | OpenAPS predictions |

### 3.4 Report Plugins (`report`)

Generate historical analysis reports.

| Plugin | Purpose |
|--------|---------|
| `dailystats` | Daily statistics |
| `glucosedistribution` | Time in range analysis |
| `hourlystats` | Hourly breakdown |
| `percentile` | Percentile charts |

### 3.5 Notification Plugins

Generate alarms and notifications.

| Plugin | Purpose |
|--------|---------|
| `simplealarms` | Basic high/low alarms |
| `ar2` | Predictive alarms |
| `treatmentnotify` | Treatment notifications |
| `errorcodes` | Error condition alerts |

### 3.6 Data Processing Plugins

Process and calculate derived values.

| Plugin | Purpose |
|--------|---------|
| `iob` | Insulin on board calculation |
| `cob` | Carbs on board calculation |
| `basalprofile` | Basal rate display |
| `boluswizardpreview` | Bolus calculator |

---

## 4. Plugin Lifecycle

### 4.1 Initialization

```javascript
function init (ctx) {
  var plugin = {
    name: 'myplugin',
    label: 'My Plugin',
    pluginType: 'pill-status'
  };
  
  // Plugin-specific initialization
  
  return plugin;
}
module.exports = init;
```

### 4.2 Runtime Methods

| Method | When Called | Purpose |
|--------|-------------|---------|
| `setProperties(sbx)` | After data load | Calculate derived values |
| `checkNotifications(sbx)` | After properties set | Generate alarms |
| `updateVisualisation(sbx)` | After UI render | Update UI elements |
| `visualizeAlarm(sbx, alarm)` | On alarm | Custom alarm display |
| `getEventTypes(sbx)` | On request | Return supported events |

### 4.3 Sandbox (sbx)

**Location:** `lib/sandbox.js`

The sandbox provides a safe execution context for plugins:

```javascript
sbx = {
  data: ctx.ddata,              // Current data
  settings: env.settings,       // Settings
  pluginBase: plugins.base,     // Base utilities
  
  // Helper methods
  scaleMgdl: function(value) { },
  roundBGToDisplayFormat: function(value) { },
  
  // Properties set by plugins
  properties: {},
  
  // Notification methods
  notifications: {
    requestNotify: function(notify) { },
    requestSnooze: function(snooze) { }
  }
};
```

---

## 5. Plugin Inventory

### 5.1 Client Default Plugins (24)

| Plugin | Type | Description | Settings |
|--------|------|-------------|----------|
| `bgnow` | pill-primary | Current BG display | None |
| `rawbg` | pill-primary | Raw BG values | RAWBG_ENABLE |
| `direction` | pill-status | Trend arrows | None |
| `timeago` | pill-status | Time since reading | TIMEAGO_ENABLE |
| `upbat` | pill-status | Uploader battery | UPBAT_ENABLE |
| `ar2` | forecast | Prediction algorithm | AR2_ENABLE |
| `errorcodes` | notification | CGM error codes | ERRORCODES_ENABLE |
| `iob` | data | Insulin on board | IOB_ENABLE |
| `cob` | data | Carbs on board | COB_ENABLE |
| `careportal` | UI | Treatment entry | CAREPORTAL_ENABLE |
| `pump` | pill-status | Pump status | PUMP_ENABLE |
| `openaps` | forecast | OpenAPS status | OPENAPS_ENABLE |
| `xdripjs` | data | xDrip+ status | XDRIPJS_ENABLE |
| `loop` | forecast | Loop status | LOOP_ENABLE |
| `override` | data | Override status | OVERRIDE_ENABLE |
| `boluswizardpreview` | data | Bolus calculator | BWP_ENABLE |
| `cannulaage` | pill-status | Cannula age | CAGE_ENABLE |
| `sensorage` | pill-status | Sensor age | SAGE_ENABLE |
| `insulinage` | pill-status | Insulin age | IAGE_ENABLE |
| `batteryage` | pill-status | Battery age | BAGE_ENABLE |
| `basalprofile` | data | Basal rate display | BASAL_ENABLE |
| `bolus` | settings | Bolus settings | None |
| `boluscalc` | UI | Bolus calculator | BOLUSCALC_ENABLE |
| `profile` | settings | Profile settings | None |
| `speech` | UI | Voice announcements | SPEECH_ENABLE |
| `dbsize` | admin | Database size | DBSIZE_ENABLE |

### 5.2 Server Default Plugins (21)

Server-only plugins (subset of client + server-specific):

| Plugin | Additional Notes |
|--------|-----------------|
| `simplealarms` | Server-only: basic threshold alarms |
| `treatmentnotify` | Server-only: treatment notifications |
| `runtimestate` | Server-only: runtime state tracking |

### 5.3 External Plugins

| Plugin | Location | Purpose |
|--------|----------|---------|
| `pushover` | `lib/plugins/pushover.js` | Pushover notifications |
| `maker` | `lib/plugins/maker.js` | IFTTT integration |
| `alexa` | `lib/plugins/alexa.js` | Alexa skill |
| `googlehome` | `lib/plugins/googlehome.js` | Google Home actions |
| `bridge` | `lib/plugins/bridge.js` | Dexcom Share bridge |
| `mmconnect` | `lib/plugins/mmconnect.js` | Medtronic CareLink |

---

## 6. Key Plugin Details

### 6.1 BGNow Plugin

**Location:** `lib/plugins/bgnow.js`

**Purpose:** Calculate and display current blood glucose

**Properties Set:**
```javascript
sbx.properties.bgnow = {
  mean: averageBG,          // Average of recent readings
  last: latestReading,      // Most recent reading
  sgvs: recentReadings,     // Last few readings
  buckets: timeBuckets      // Readings grouped by time
};
```

### 6.2 AR2 Plugin

**Location:** `lib/plugins/ar2.js`

**Purpose:** Auto-regressive prediction algorithm

**Algorithm:**
1. Takes last 2 readings
2. Applies AR(2) coefficients
3. Projects 5, 10, 15, 20, 25, 30 minute values
4. Calculates probability of crossing thresholds

**Alarm Logic:**
```javascript
if (probability > URGENT_THRESHOLD) {
  // Request urgent alarm
} else if (probability > WARN_THRESHOLD) {
  // Request warning alarm
}
```

### 6.3 IOB Plugin

**Location:** `lib/plugins/iob.js`

**Purpose:** Calculate insulin on board

**Calculation:**
- Uses DIA (Duration of Insulin Action) from profile
- Sums active insulin from recent boluses
- Applies decay curve

### 6.4 COB Plugin

**Location:** `lib/plugins/cob.js`

**Purpose:** Calculate carbs on board

**Calculation:**
- Uses carb absorption rate from profile
- Tracks unabsorbed carbs from recent meals
- Considers carb ratio and absorption patterns

### 6.5 Loop/OpenAPS Plugins

**Location:** `lib/plugins/loop.js`, `lib/plugins/openaps.js`

**Purpose:** Display closed-loop system status

**Data Sources:**
- Device status entries from Loop/OpenAPS
- Predicted glucose values
- Enacted temp basals
- IOB/COB from loop calculations

---

## 7. Pebble Watch Integration

### 7.1 Pebble API

**Location:** `lib/server/pebble.js`

**Endpoint:** `GET /pebble`

**Response Format:**
```json
{
  "bgs": [
    {
      "sgv": "120",
      "trend": 4,
      "direction": "Flat",
      "datetime": 1595000000000,
      "filtered": 124048,
      "unfiltered": 118880,
      "noise": 1,
      "battery": "100"
    }
  ],
  "cals": [],
  "status": [
    {
      "now": 1595000000000
    }
  ]
}
```

### 7.2 Direction Mapping

```javascript
var DIRECTIONS = {
  NONE: 0,
  DoubleUp: 1,
  SingleUp: 2,
  FortyFiveUp: 3,
  Flat: 4,
  FortyFiveDown: 5,
  SingleDown: 6,
  DoubleDown: 7,
  'NOT COMPUTABLE': 8,
  'RATE OUT OF RANGE': 9
};
```

### 7.3 Pebble Plugin Features

- Trend arrow display
- Battery status
- Time since last reading
- Delta (change since last reading)
- Optional: IOB, COB, predictions

---

## 8. Report Plugins

### 8.1 Report Plugin Structure

**Location:** `lib/report_plugins/`

| Plugin | File | Reports Generated |
|--------|------|-------------------|
| dailystats | `dailystats.js` | Daily average, min, max, std dev |
| glucosedistribution | `glucosedistribution.js` | Time in range percentages |
| hourlystats | `hourlystats.js` | Hour-by-hour breakdown |
| percentile | `percentile.js` | Percentile overlay chart |

### 8.2 Report Plugin Interface

```javascript
var reportPlugin = {
  name: 'dailystats',
  label: 'Daily Stats',
  pluginType: 'report'
};

reportPlugin.html = function(client) {
  // Return HTML template
};

reportPlugin.css = 'CSS styles here';

reportPlugin.report = function(datastorage, sorteddaystoshow, options) {
  // Generate report data
};
```

---

## 9. Plugin Configuration

### 9.1 Enabling Plugins

**Environment Variable:**
```
ENABLE=careportal iob cob openaps pump
```

**Programmatic:**
```javascript
env.settings.enable = ['careportal', 'iob', 'cob'];
```

### 9.2 Extended Settings

Plugins can have extended settings:
```
PUMP_FIELDS=clock reservoir battery
IOB_FRAC=0.5
```

**Access in Plugin:**
```javascript
var settings = sbx.extendedSettings;
var pumpFields = settings.pump.fields;
```

### 9.3 Settings Schema

No formal settings schema exists. Each plugin defines its own settings interpretation.

**Recommendation:** Add JSON Schema for plugin settings validation.

---

## 10. Extension Points

### 10.1 Data Processing Extension

Add new calculations:
```javascript
plugin.setProperties = function(sbx) {
  sbx.properties.myplugin = {
    value: calculateValue(sbx.data)
  };
};
```

### 10.2 Notification Extension

Add new alarm types:
```javascript
plugin.checkNotifications = function(sbx) {
  if (condition) {
    sbx.notifications.requestNotify({
      level: sbx.levels.WARN,
      title: 'My Alarm',
      message: 'Description',
      plugin: plugin
    });
  }
};
```

### 10.3 Visualization Extension

Add UI elements:
```javascript
plugin.updateVisualisation = function(sbx) {
  $('#my-element').text(sbx.properties.myplugin.value);
};
```

### 10.4 Event Type Extension

Add treatment types:
```javascript
plugin.getEventTypes = function(sbx) {
  return [{
    val: 'MyEvent',
    name: 'My Custom Event'
  }];
};
```

### 10.5 Voice Assistant Extension

Add Alexa/Google Home intents:
```javascript
plugin.virtAsst = {
  intentHandlers: [{
    intent: 'MyIntent',
    handler: function(callback, slots, sbx) {
      callback('Response text', 'Card title', 'Card content');
    }
  }]
};
```

---

## 11. Issues and Recommendations

### 11.1 Architecture Issues

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| No plugin isolation | Security risk | Add sandboxing |
| Global state mutation | Race conditions | Immutable data patterns |
| No async support | Blocking operations | Add async lifecycle |
| Tight DOM coupling | Testing difficulty | Decouple from DOM |
| No plugin versioning | Compatibility issues | Add version metadata |

### 11.2 Developer Experience Issues

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| No TypeScript support | Type errors | Add TypeScript definitions |
| Limited documentation | Learning curve | Document plugin API |
| No plugin template | Slow onboarding | Create plugin generator |
| No testing utilities | Quality issues | Add testing helpers |

### 11.3 Modernization Recommendations

1. **Plugin Isolation:**
   - Run plugins in separate contexts
   - Add capability-based permissions
   - Implement resource limits

2. **Async Support:**
   ```javascript
   plugin.setProperties = async function(sbx) {
     const data = await fetchExternalData();
     sbx.properties.myplugin = data;
   };
   ```

3. **Plugin Manifest:**
   ```json
   {
     "name": "myplugin",
     "version": "1.0.0",
     "requires": ["bgnow"],
     "permissions": ["notifications"],
     "settings": {
       "threshold": { "type": "number", "default": 100 }
     }
   }
   ```

4. **Hot Reloading:**
   - Enable plugin updates without restart
   - Add plugin state serialization

---

## 12. Plugin Testing

### 12.1 Current State

- Limited unit tests in `tests/` directory
- Manual testing predominant
- No integration test framework

### 12.2 Testing Recommendations

**Unit Test Template:**
```javascript
describe('myplugin', function() {
  var ctx, sbx;
  
  beforeEach(function() {
    ctx = require('./ctx-mock')();
    sbx = require('./sbx-mock')(ctx);
  });
  
  it('should calculate value correctly', function() {
    var plugin = require('../lib/plugins/myplugin')(ctx);
    plugin.setProperties(sbx);
    sbx.properties.myplugin.value.should.equal(expected);
  });
});
```

---

## 13. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [Dashboard UI Audit](./dashboard-ui-audit.md)
- [Real-Time Systems Audit](./realtime-systems-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)
