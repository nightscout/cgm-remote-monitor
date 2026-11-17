'use strict';
const path = require('node:path');
// The optional root selects a local reference checkout for paired measurements.
/* eslint-disable security/detect-non-literal-require */
const root = process.argv[2] || path.resolve(__dirname, '..'), days = Number(process.argv[3] || 1);
const moment = require(path.join(root, 'node_modules/moment-timezone'));
const create = require(path.join(root, 'lib/profilefunctions'));
const profile = create([{startDate: '2020-01-01T00:00:00Z', timezone: 'UTC', dia: 3, carbs_hr: 30, carbratio: 7, sens: 35, target_low: 95, target_high: 120, basal: [{time:'00:00',value:0.8},{time:'12:00',value:1}]}], {moment});
const heap = () => {global.gc(); return process.memoryUsage().heapUsed;};
const before = heap(), rounds = [];
for (let round = 0; round < 2; round++) {
 let sum = 0; const start = performance.now();
 for (let i = 0; i < days*1440; i++) {
  const time = Date.UTC(2026,0,1) + i*60000;
  for (const field of ['basal','sens','carbratio','target_low','target_high','dia']) sum += profile.getValueByTime(time,field);
 }
 rounds.push({ms:performance.now()-start,sum});
}
const retainedBytes = heap()-before;
profile.clear();
if (!rounds.every(r=>Number.isFinite(r.sum))) throw new Error('Invalid output');
console.log(JSON.stringify({days,rounds,retainedBytes}));
