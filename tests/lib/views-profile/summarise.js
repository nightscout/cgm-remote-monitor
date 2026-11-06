'use strict';

// Summarise --profile replay runs: node tests/lib/views-profile/summarise.js <dir>...
// Counts, minutes and plugin names only.

const fs = require('fs');
const path = require('path');

for (const dir of process.argv.slice(2)) {
  const rows = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(function (f) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const p = r.profile || {};
    const m = p.minutes || {};
    const plugins = Object.entries(r.view.plugins || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + ' ' + v).join(', ');
    return [f.replace('.json', ''), r.steps, r.view.any, r.view.differsEvaluated || 0, r.view.differsNotEvaluated || 0, r.r2 ? r.r2.any : '-', m.evaluated, m.notEvaluated, m.withUploads, m.uploadsWithoutWriteEvent, r.errors, r.mongodb, r.node, plugins].join(' | ');
  });
  console.log('## ' + path.basename(dir));
  console.log('dataset | minutes | differ | differ (evaluated) | differ (not evaluated) | r2 differ | evaluated | not evaluated | minutes with uploads | uploads with no write event | errors | mongodb | node | top plugins');
  rows.forEach(r => console.log(r));
}
