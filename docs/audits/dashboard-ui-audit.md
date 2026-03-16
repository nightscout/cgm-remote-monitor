# Dashboard UI Audit

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Scope:** Client bundle structure, D3 charting, clock displays, browser settings, rendering pipeline

---

## 1. Executive Summary

The Nightscout web dashboard provides real-time glucose visualization with extensive customization options. This audit examines the frontend architecture, rendering pipeline, and modernization opportunities.

### Dashboard Overview

| Metric | Value |
|--------|-------|
| Bundle System | Webpack 5 |
| UI Framework | jQuery + D3.js |
| Charting | D3.js v5 + Flot |
| Real-time Updates | Socket.IO |
| Bundle Size | ~1MB+ (production) |

---

## 2. Client Bundle Architecture

### 2.1 Entry Point

**Location:** `bundle/bundle.source.js`

```javascript
import '../static/css/drawer.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';

$ = require("jquery");
require('jquery-ui-bundle');

window._ = require('lodash');
window.d3 = require('d3');

require('jquery.tooltips');
window.Storage = require('js-storage');

require('flot');
require('../node_modules/flot/jquery.flot.time');
```

### 2.2 Module Structure

```
bundle/
└── bundle.source.js      # Main entry point

lib/client/
├── index.js              # Client initialization
├── chart.js              # D3 chart rendering
├── renderer.js           # UI rendering utilities
├── hashauth.js           # Client-side authentication
├── browser-settings.js   # User preferences
├── receiveddata.js       # Data merge/cache logic
└── socket.js             # WebSocket handling
```

### 2.3 Build Configuration

**Location:** `webpack/webpack.config.js`

**Key Settings:**
- Output: `static/bundle.js`
- Mode: production/development
- Moment locale optimization
- Babel transpilation

**Scripts:**
```json
{
  "bundle": "webpack --mode production --config webpack/webpack.config.js",
  "bundle-dev": "webpack --mode development --config webpack/webpack.config.js",
  "bundle-analyzer": "webpack --mode development ... --json > stats.json && webpack-bundle-analyzer stats.json"
}
```

---

## 3. UI Framework Components

### 3.1 jQuery Usage

**Version:** ^3.5.1

**Primary Uses:**
- DOM manipulation
- Event handling
- AJAX requests (deprecated pattern)
- jQuery UI for dialogs, datepickers

**Code Pattern:**
```javascript
$('#container').html(content);
$('.sgv-pill').removeClass('urgent').addClass('info');
$('#currentBG').text(utils.scaleMgdl(bg));
```

### 3.2 D3.js Usage

**Version:** ^5.16.0

**Primary Uses:**
- SVG chart rendering
- Data binding
- Scales and axes
- Transitions and animations

**Chart Types:**
- Main glucose chart (focus area)
- Context brush chart (overview)
- Treatment overlays
- Prediction lines

### 3.3 Flot Usage

**Version:** ^0.8.3 (legacy)

**Primary Uses:**
- Report charts
- Pie charts (glucose distribution)
- Time-series in reports

**Status:** Legacy dependency, candidate for removal

---

## 4. Main Chart Implementation

### 4.1 Chart Structure

**Location:** `lib/client/chart.js`

```
┌─────────────────────────────────────────────────────────────┐
│                     Focus Chart Area                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                                                         │ │
│  │     Glucose readings (SGV dots)                        │ │
│  │     Trend line                                          │ │
│  │     Predictions (if enabled)                           │ │
│  │     Treatment markers                                   │ │
│  │     Basal profile (if enabled)                         │ │
│  │                                                         │ │
│  │     Y-axis: mg/dL or mmol/L                            │ │
│  │     X-axis: Time                                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           Context Chart (Brush Selector)                │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Chart Initialization

```javascript
function init (client, d3, $) {
  var chart = {};
  
  var utils = client.utils;
  var renderer = client.renderer;
  
  // Define scales
  chart.xScale = d3.scaleTime();
  chart.yScale = d3.scaleLinear();
  
  // Define axes
  chart.xAxis = d3.axisBottom(chart.xScale);
  chart.yAxis = d3.axisLeft(chart.yScale);
  
  // Define brush for context chart
  chart.brush = d3.brushX();
  
  return chart;
}
```

### 4.3 Data Rendering

**Glucose Readings:**
```javascript
chart.bindData(sgvs)
  .enter()
  .append('circle')
  .attr('class', function(d) { return 'sgv ' + getColorClass(d); })
  .attr('cx', function(d) { return chart.xScale(d.mills); })
  .attr('cy', function(d) { return chart.yScale(d.sgv); })
  .attr('r', 3);
```

**Treatments:**
```javascript
chart.renderTreatments(treatments)
  .enter()
  .append('g')
  .attr('class', 'treatment')
  .attr('transform', function(d) {
    return 'translate(' + chart.xScale(d.mills) + ',' + y + ')';
  });
```

### 4.4 Color Coding

| Range | Class | Default Color |
|-------|-------|---------------|
| Urgent High | `urgent` | Red |
| High | `warn` | Yellow |
| In Range | `inrange` | Green |
| Low | `warn` | Yellow |
| Urgent Low | `urgent` | Red |

**Thresholds (configurable):**
```javascript
BG_HIGH=260
BG_TARGET_TOP=180
BG_TARGET_BOTTOM=80
BG_LOW=55
```

---

## 5. Clock Display Views

### 5.1 Clock View Types

**Location:** `views/clockviews/`

| View | Purpose | Features |
|------|---------|----------|
| Clock | Simple clock display | BG, time, trend |
| Color Clock | Color-coded by range | Visual range indication |
| BGClock | BG-focused display | Large BG, delta |
| Simple BG | Minimal display | BG only |

### 5.2 Clock CSS Structure

**Location:** `views/clockviews/clock-shared.css`

```css
body {
  text-align: center;
  background-color: black;
  color: grey;
  overflow: hidden;
}

#currentBG {
  font-size: 20vmin;
  font-weight: bold;
}

#currentDelta {
  font-size: 10vmin;
}
```

### 5.3 Clock Configuration

**Location:** `views/clockviews/clock-config.css`

Configuration panel for:
- Time format (12h/24h)
- Units (mg/dL, mmol/L)
- Display elements visibility
- Color themes

---

## 6. Browser Settings

### 6.1 Settings Storage

**Location:** `lib/client/browser-settings.js`

Uses `js-storage` for localStorage management:

```javascript
var Storages = require('js-storage');
var storage = Storages.localStorage;

browserSettings.load = function() {
  return storage.get(STORAGE_KEY) || {};
};

browserSettings.save = function(settings) {
  storage.set(STORAGE_KEY, settings);
};
```

### 6.2 Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `units` | string | "mg/dl" | Display units |
| `timeFormat` | number | 12 | Time format (12/24) |
| `nightMode` | boolean | false | Dark theme |
| `showRawbg` | string | "never" | Raw BG display |
| `customTitle` | string | "Nightscout" | Custom page title |
| `theme` | string | "default" | Color theme |
| `alarmUrgentHigh` | boolean | true | Enable urgent high alarm |
| `alarmHigh` | boolean | true | Enable high alarm |
| `alarmLow` | boolean | true | Enable low alarm |
| `alarmUrgentLow` | boolean | true | Enable urgent low alarm |
| `alarmTimeagoWarn` | boolean | true | Enable stale data warning |

### 6.3 Settings Sync

Settings are stored locally and not synced:
- Each browser has independent settings
- No server-side storage of preferences
- Token-based URL sharing possible

---

## 7. Rendering Pipeline

### 7.1 Initial Load

```
Page Load
    ↓
Load bundle.js (~1MB)
    ↓
Initialize client
    ↓
Fetch /api/v1/status
    ↓
Connect WebSocket
    ↓
Fetch initial data (/api/v1/entries, /api/v1/treatments)
    ↓
Render chart
    ↓
Subscribe to updates
```

### 7.2 Real-Time Update Cycle

```
WebSocket dataUpdate event
    ↓
receiveDData.mergeDataUpdate()
    ↓
Update local data cache
    ↓
Run plugins (setProperties)
    ↓
Update pills and status
    ↓
chart.update()
    ↓
D3 data binding
    ↓
DOM update
```

### 7.3 Performance Metrics

| Metric | Typical Value | Target |
|--------|--------------|--------|
| Initial bundle load | 1-2s | <1s |
| First paint | 2-3s | <1.5s |
| Chart render | 100-200ms | <100ms |
| Data update | 50-100ms | <50ms |

---

## 8. View Templates

### 8.1 Template Engine

**Engine:** EJS (Embedded JavaScript)

**Main Template:** `views/index.html`

### 8.2 Page Structure

```html
<!DOCTYPE html>
<html>
<head>
  <title>Nightscout</title>
  <link rel="stylesheet" href="/bundle/bundle.css">
</head>
<body>
  <nav id="navbar">
    <!-- Navigation and pills -->
  </nav>
  
  <main>
    <div id="container">
      <svg id="chartContainer"></svg>
    </div>
  </main>
  
  <script src="/bundle/bundle.js"></script>
</body>
</html>
```

### 8.3 Available Views

| Route | View | Purpose |
|-------|------|---------|
| `/` | index | Main dashboard |
| `/report` | report | Reports viewer |
| `/profile` | profile | Profile editor |
| `/admin` | admin | Admin tools |
| `/food` | food | Food database |
| `/clock` | clock | Simple clock |
| `/clock-color` | clock-color | Color clock |
| `/bgclock` | bgclock | BG clock |
| `/simplebg` | simplebg | Simple BG |

---

## 9. Responsive Design

### 9.1 Current State

- Desktop-first design
- Limited mobile optimization
- Fixed breakpoints

### 9.2 Breakpoints

```css
/* Example from existing CSS */
@media (max-width: 768px) {
  .toolbar { display: none; }
  #container { width: 100%; }
}
```

### 9.3 Mobile Issues

| Issue | Impact | Status |
|-------|--------|--------|
| Touch events | Poor mobile interaction | Partial |
| Chart zoom | Pinch zoom not supported | Open |
| Portrait mode | Layout issues | Partial |
| PWA support | Not installable | Open |

---

## 10. Accessibility

### 10.1 Current State

- Limited ARIA labels
- No keyboard navigation
- Color-only status indication
- No screen reader support

### 10.2 Accessibility Issues

| Issue | WCAG | Priority |
|-------|------|----------|
| Missing alt text | 1.1.1 | High |
| Color contrast | 1.4.3 | Medium |
| Focus indicators | 2.4.7 | Medium |
| Status announcements | 4.1.3 | High |

### 10.3 Recommendations

1. Add ARIA labels to interactive elements
2. Implement keyboard navigation
3. Add screen reader announcements for alarms
4. Improve color contrast ratios
5. Add focus visible styles

---

## 11. Performance Optimization

### 11.1 Bundle Size Analysis

**Current Bundle (~1MB+):**

| Library | Size (approx) | Optimization |
|---------|--------------|--------------|
| D3.js | 250KB | Tree-shake unused |
| jQuery | 90KB | Consider removal |
| Lodash | 70KB | Use lodash-es |
| Moment.js | 230KB | Replace with dayjs |
| Socket.IO | 50KB | Current |
| Flot | 100KB | Remove (legacy) |

### 11.2 Optimization Strategies

1. **Code Splitting:**
   ```javascript
   // Dynamic import for reports
   const reports = await import('./reports');
   ```

2. **Tree Shaking:**
   ```javascript
   // Instead of:
   import _ from 'lodash';
   // Use:
   import { debounce, throttle } from 'lodash-es';
   ```

3. **Lazy Loading:**
   - Load reports module on demand
   - Defer non-critical CSS

4. **Asset Optimization:**
   - Compress images
   - Use WebP format
   - Implement caching headers

### 11.3 Performance Budget

| Metric | Current | Target |
|--------|---------|--------|
| Bundle size (gzip) | ~300KB | <200KB |
| First contentful paint | 2.5s | <1.5s |
| Time to interactive | 4s | <2s |
| Lighthouse score | ~60 | >80 |

---

## 12. Issues and Recommendations

### 12.1 Critical Issues

| Issue | Impact | Recommendation |
|-------|--------|----------------|
| Large bundle size | Slow initial load | Code splitting |
| No PWA support | Mobile experience | Add service worker |
| jQuery dependency | Maintenance burden | Migrate to vanilla JS |

### 12.2 UI Framework Migration

**Options:**

1. **Vanilla JavaScript:**
   - Pros: No framework overhead
   - Cons: More code to maintain

2. **React:**
   - Pros: Large ecosystem, component model
   - Cons: Significant rewrite

3. **Vue.js:**
   - Pros: Gentle learning curve
   - Cons: Less ecosystem than React

4. **Svelte:**
   - Pros: Small bundle, no virtual DOM
   - Cons: Smaller ecosystem

**Recommendation:** Consider incremental migration to Svelte or Vue for new features while maintaining existing code.

### 12.3 Chart Library Migration

**D3.js v5 → v7:**
- Breaking changes in API
- Worth migrating for bundle size
- Better TypeScript support

**Alternative: Chart.js:**
- Pros: Simpler API, smaller bundle
- Cons: Less customization
- Suitable for reports

### 12.4 Modernization Roadmap

1. **Phase 1 (0-3 months):**
   - Add service worker for PWA
   - Implement code splitting
   - Replace Moment.js with dayjs

2. **Phase 2 (3-6 months):**
   - Migrate from jQuery to vanilla JS
   - Add responsive design improvements
   - Implement accessibility basics

3. **Phase 3 (6-12 months):**
   - Consider framework adoption
   - Upgrade D3.js to v7
   - Remove Flot dependency

---

## 13. Related Documents

- [Architecture Overview](../meta/architecture-overview.md)
- [Plugin Architecture Audit](./plugin-architecture-audit.md)
- [Real-Time Systems Audit](./realtime-systems-audit.md)
- [Modernization Roadmap](../meta/modernization-roadmap.md)
