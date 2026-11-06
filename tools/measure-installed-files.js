'use strict';

// Filesystem bytes, not allocated disk blocks, compressed image size or RAM.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'node_modules');
let files = 0, bytes = 0;
function visit(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (['.cache', '.bin', '.package-lock.json'].includes(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(location);
    else if (entry.isFile()) {files++; bytes += fs.statSync(location).size;}
  }
}
visit(root);
console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch, files, bytes}));
