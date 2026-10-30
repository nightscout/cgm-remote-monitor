'use strict';

// Summarise a replay lab output directory (tests/lib/views-replay/run-all.sh)
// as markdown: counts, minutes and plugin names only, never notification text.
//
//   node tests/lib/views-replay/summarise.js <OUT dir> [mode ...]
//
// A minute where the view differs from the server is classed:
//   expected   every differing notification is sage's (the decided
//              newest-Sensor-Start difference, docs/60-research/platform/
//              st-views-census-2026-10-27.md section 4 item 4)
//   artefact   the r2 control (a second resident path) differs from the
//              server on the same minute, in the same plugins
//   real       anything else
// The details (.jsonl) are read for this and nothing from them is printed but
// plugin names and levels.

const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const modes = process.argv.slice(3);

function pluginOf (sig) { const p = sig.split('|'); return p[0] === 'notify' || p[0] === 'snooze' ? p[3] : (p[6] === 'clear' ? 'clear:' + p[1] : p[2]); }

function readDetails (file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function pluginsOf (d) {
  return [...new Set([].concat(d.emitted.onlyServer, d.emitted.onlyOther, d.requested.onlyServer, d.requested.onlyOther).map(pluginOf))].sort();
}

function hoursRanges (steps) {
  // contiguous minute runs, in hours from the replay start
  const runs = [];
  steps.sort((a, b) => a - b).forEach(function (s) {
    const last = runs[runs.length - 1];
    if (last && s === last[1] + 1) last[1] = s; else runs.push([s, s]);
  });
  return runs.map(r => (r[0] / 60).toFixed(2) + '-' + ((r[1] + 1) / 60).toFixed(2) + 'h');
}

const dirs = (modes.length ? modes : fs.readdirSync(out)).filter(m => fs.statSync(path.join(out, m)).isDirectory());
dirs.forEach(function (mode) {
  const dir = path.join(out, mode);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  console.log('\n### ' + mode + '\n');
  console.log('| dataset | span (h) | minutes compared | view differs | expected (sage) | artefact (r2 also differs) | real | r2 differs from server | differing plugins (view) | runs (h from start) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  files.forEach(function (f) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const det = readDetails(path.join(dir, f.replace(/\.json$/, '.jsonl')));
    const r2 = new Map(det.filter(d => d.pair === 'server-r2').map(d => [d.step, pluginsOf(d)]));
    const v = det.filter(d => d.pair === 'server-view');
    const cls = { expected: 0, artefact: 0, real: 0 };
    const realSteps = [];
    v.forEach(function (d) {
      const p = pluginsOf(d);
      if (p.every(x => x === 'sage')) cls.expected++;
      else if (r2.has(d.step) && p.every(x => r2.get(d.step).includes(x))) cls.artefact++;
      else { cls.real++; realSteps.push(d.step); }
    });
    const plugins = {};
    v.forEach(d => pluginsOf(d).forEach(p => { plugins[p] = (plugins[p] || 0) + 1; }));
    const runs = hoursRanges(v.map(d => d.step));
    console.log('| ' + [r.dataset, r.spanHours.toFixed(1), r.steps, r.view.any, cls.expected, cls.artefact, cls.real, r.r2 ? r.r2.any : 'not run',
      Object.keys(plugins).map(p => p + ' ' + plugins[p]).join(', ') || '-', runs.length > 8 ? runs.slice(0, 8).join(' ') + ' ... (' + runs.length + ' runs)' : runs.join(' ') || '-'].join(' | ') + ' |');
  });
});
