'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {gzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
assert.ok(process.argv[2], 'Pass the old built worktree root');
const oldRoot = path.resolve(process.argv[2]);
function size(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).reduce((sum, entry) => {
    const file = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? size(file) : entry.isFile() ? fs.statSync(file).size : 0);
  }, 0);
}
const old = require(path.join(oldRoot, 'node_modules/moment-timezone'));
const current = require('moment-timezone');
const before = require(path.join(oldRoot, 'node_modules/moment-timezone/data/packed/latest.json'));
const after = require('moment-timezone/data/packed/latest.json');
const countries = [...new Set([...old.tz.countries(), ...current.tz.countries()])];
const result = {node: process.version, oldVersion: old.tz.version, newVersion: current.tz.version,
  changedCountries: countries.filter(country => JSON.stringify(old.tz.zonesForCountry(country)) !== JSON.stringify(current.tz.zonesForCountry(country))),
  removedLinks: before.links.filter(link => !after.links.includes(link)),
  addedLinks: after.links.filter(link => !before.links.includes(link)),
  packageBytes: {old: size(path.join(oldRoot, 'node_modules/moment-timezone')), current: size(path.dirname(require.resolve('moment-timezone')))}, bundles: {}};
for (const entry of ['app', 'clock', 'reports', 'admin', 'food', 'profile']) {
  const file = 'node_modules/.cache/_ns_cache/public/js/bundle.' + entry + '.js';
  const oldData = fs.readFileSync(path.join(oldRoot, file)), newData = fs.readFileSync(file);
  result.bundles[entry] = {oldBytes: oldData.length, newBytes: newData.length,
    oldGzip: gzipSync(oldData).length, newGzip: gzipSync(newData).length,
    oldSha256: createHash('sha256').update(oldData).digest('hex'),
    newSha256: createHash('sha256').update(newData).digest('hex'), identical: oldData.equals(newData)};
}
result.scope = 'Both roots must be built with the same Node/build toolchain. Installed regular-file bytes and JS transfer bytes only; no runtime heap or RSS measurement.';
console.log(JSON.stringify(result, null, 2));
