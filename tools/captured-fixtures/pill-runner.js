'use strict';

/**
 * Shared runner that drives the pill-emitting plugins in `lib/plugins/`
 * against a captured-fixture directory under `tests/fixtures/captured/<source>/`.
 *
 * Used by:
 *   - tools/captured-fixtures/generate-pill-goldens.js  (writes the golden)
 *   - tests/client-core/pill-goldens.test.js            (asserts no drift)
 *
 * Why pills?
 *   The user-visible pills produced by `lib/plugins/*` are the most
 *   stable, headless-testable representation of "what the dashboard
 *   shows". They are emitted via a single chokepoint
 *   (`pluginBase.updatePillText(plugin, options)`), do not require a
 *   browser, and run end-to-end (data → setProperties → updateVisualisation
 *   → pill text). Locking these as goldens against captured real-world
 *   payloads gives a regression net for any refactor that touches the
 *   plugin chain (sandbox, properties, formatting, units, language).
 *
 * Determinism notes:
 *   - sandbox.clientInit takes a `time` argument; we pin it to
 *     max(mills) + 60_000ms (one minute after the latest captured record)
 *     across (sgvs ∪ treatments ∪ devicestatus) so output does not depend
 *     on wall-clock. This matches the convention in
 *     tests/client-core/devicestatus-openaps.test.js. The +60s keeps
 *     "now" strictly outside the most recent record so timeago and
 *     recent-window plugins do not sit on a boundary. Any future anchor
 *     change requires `node tools/captured-fixtures/generate-pill-goldens.js
 *     --write` and review of the resulting drift.
 *   - Plugin output order is the order in PILL_PLUGINS below.
 *   - Floats are JSON-serialized as-is; if a future change introduces
 *     non-determinism (Date.now(), Math.random(), iteration order),
 *     the golden test will surface it.
 */

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

// Plugins that emit pills. Order matters for determinism only.
// Some plugins require properties from earlier plugins (e.g. boluswizardpreview
// reads iob/cob); we run setProperties for ALL plugins before any
// updateVisualisation so cross-plugin properties are populated.
const PILL_PLUGINS = [
  'rawbg',
  'iob',
  'cob',
  'direction',
  'upbat',
  'errorcodes',
  'basalprofile',
  'bgnow',
  'ar2',
  'cannulaage',
  'insulinage',
  'sensorage',
  'batteryage',
  'boluswizardpreview',
  'loop',
  'openaps',
  'override',
  'pump',
  'timeago',
  'dbsize',
];

function readJSON (file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureMills (records, dateField) {
  if (!Array.isArray(records)) return records;
  for (const r of records) {
    if (r && typeof r === 'object' && r.mills == null) {
      const dv = r[dateField];
      if (typeof dv === 'number') {
        r.mills = dv;
      } else if (typeof dv === 'string') {
        r.mills = new Date(dv).getTime();
      }
    }
  }
  return records;
}

function loadFixture (sourceDir) {
  const sgvs = ensureMills(readJSON(path.join(sourceDir, 'entries.json')) || [], 'date');
  const treatments = ensureMills(readJSON(path.join(sourceDir, 'treatments.json')) || [], 'created_at');
  const devicestatus = ensureMills(readJSON(path.join(sourceDir, 'devicestatus.json')) || [], 'created_at');
  const profileRecords = readJSON(path.join(sourceDir, 'profile.json')) || null;
  return { sgvs, treatments, devicestatus, profileRecords };
}

function pickTime ({ sgvs, treatments, devicestatus }) {
  let max = 0;
  for (const arr of [sgvs, treatments, devicestatus]) {
    for (const r of arr) {
      if (r && r.mills > max) max = r.mills;
    }
  }
  // Fall back to a fixed deterministic instant if nothing has timestamps.
  return max ? max + 60_000 : Date.UTC(2026, 4, 9, 0, 0, 0);
}

function buildCtx (profileRecords) {
  const language = require('../../lib/language')(fs);
  language.set('en');
  const settings = require('../../lib/settings')();
  settings.units = 'mg/dl';
  settings.timeFormat = 24;
  // Show all plugins so timeago/etc. don't bail early.
  settings.showPlugins = '*';

  const levels = require('../../lib/levels');

  const ctx = {
    language,
    settings,
    levels,
    moment,
    notifications: {
      requestNotify: function () {},
    },
  };

  if (profileRecords && profileRecords.length) {
    const profilefunctions = require('../../lib/profilefunctions');
    ctx.profile = profilefunctions(profileRecords, ctx);
  }
  return ctx;
}

function captureRun (sourceDir) {
  const fixture = loadFixture(sourceDir);
  const time = pickTime(fixture);
  const ctx = buildCtx(fixture.profileRecords);

  // Recording pluginBase: capture every updatePillText call, sorted later
  // for stable output.
  const pillCalls = []; // { plugin, options }
  const forecastInfos = [];
  const forecastPoints = {};

  ctx.pluginBase = {
    forecastInfos,
    forecastPoints,
    updatePillText: function (plugin, options) {
      pillCalls.push({
        plugin: plugin && plugin.name ? plugin.name : String(plugin),
        // Strip `info` entries we cannot stringify deterministically
        // (e.g. functions). JSON.stringify will skip functions anyway,
        // but we explicitly drop unknown types for clarity.
        options: stripNonSerializable(options),
      });
    },
    addForecastPoints: function (points) {
      // Capture only count + first/last for compactness; full forecast
      // arrays are large and tested elsewhere.
      forecastPoints._summary = forecastPoints._summary || [];
      forecastPoints._summary.push({
        count: Array.isArray(points) ? points.length : 0,
        first: Array.isArray(points) && points.length ? points[0] : null,
        last: Array.isArray(points) && points.length ? points[points.length - 1] : null,
      });
    },
  };

  const sandbox = require('../../lib/sandbox')(ctx);
  const sbx = sandbox.clientInit(ctx, time, {
    sgvs: fixture.sgvs,
    treatments: fixture.treatments,
    devicestatus: fixture.devicestatus,
    profile: ctx.profile,
  });

  // Phase 1: setProperties for all plugins (so cross-plugin properties
  // like iob/cob are available to dependents like boluswizardpreview).
  const loaded = [];
  for (const name of PILL_PLUGINS) {
    let plugin;
    try {
      plugin = require(`../../lib/plugins/${name}`)(ctx);
    } catch (e) {
      loaded.push({ name, error: `load: ${e.message}` });
      continue;
    }
    try {
      if (typeof plugin.setProperties === 'function') {
        plugin.setProperties(sbx);
      }
    } catch (e) {
      loaded.push({ name, plugin, error: `setProperties: ${e.message}` });
      continue;
    }
    loaded.push({ name, plugin });
  }

  // Phase 2: updateVisualisation for all plugins.
  const errors = {};
  for (const entry of loaded) {
    if (entry.error) {
      errors[entry.name] = entry.error;
      continue;
    }
    try {
      if (typeof entry.plugin.updateVisualisation === 'function') {
        entry.plugin.updateVisualisation(sbx);
      }
    } catch (e) {
      errors[entry.name] = `updateVisualisation: ${e.message}`;
    }
  }

  // Group calls by plugin name for stable, diff-friendly JSON.
  const byPlugin = {};
  for (const c of pillCalls) {
    (byPlugin[c.plugin] = byPlugin[c.plugin] || []).push(c.options);
  }

  return {
    fixture: path.basename(sourceDir),
    time,
    pills: byPlugin,
    forecastSummary: forecastPoints._summary || [],
    errors,
  };
}

function stripNonSerializable (obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(stripNonSerializable);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (typeof v === 'function') continue;
      if (typeof v === 'object') {
        out[k] = stripNonSerializable(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return obj;
}

function stableStringify (value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function defaultSources (root) {
  const dir = path.join(root, 'tests/fixtures/captured');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(p => fs.statSync(p).isDirectory());
}

module.exports = {
  PILL_PLUGINS,
  captureRun,
  stableStringify,
  defaultSources,
};
