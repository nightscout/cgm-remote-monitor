#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'lib', 'sources', 'librelinkup.js');
const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'nightscout-connect',
  'lib',
  'sources',
  'librelinkup.js'
);

if (!fs.existsSync(source)) {
  throw new Error(`Missing source fix file: ${source}`);
}

if (!fs.existsSync(path.dirname(target))) {
  throw new Error(`Missing nightscout-connect install path: ${path.dirname(target)}`);
}

fs.copyFileSync(source, target);
console.log(`Patched nightscout-connect LibreLinkUp source: ${target}`);
