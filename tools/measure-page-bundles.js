'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {gzipSync} = require('node:zlib');
const entries = ['app', 'reports', 'admin', 'profile', 'food', 'clock'];
const output = path.resolve(__dirname, '../node_modules/.cache/_ns_cache/public/js');

function measure(directory = output) {
  const bundles = Object.fromEntries(entries.map(entry => {
    const bytes = fs.readFileSync(path.join(directory, 'bundle.' + entry + '.js'));
    return [entry, {bytes: bytes.length, gzipBytes: gzipSync(bytes, {level: 9}).length}];
  }));
  return {runtime: {node: process.versions.node, zlib: process.versions.zlib}, bundles, allApplicationGzipBytes: entries.filter(entry => entry !== 'clock')
    .reduce((total, entry) => total + bundles[entry].gzipBytes, 0)};
}

module.exports = {entries, output, measure};
if (require.main === module) console.log(JSON.stringify(measure(process.argv[2]), null, 2));
