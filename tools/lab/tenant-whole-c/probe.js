#!/usr/bin/env node
'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicit parent-owned private config argument. */
const fs = require('node:fs');
async function main () {
  if (process.argv.length !== 4 || !['all', 'C1', 'C2', 'C3', 'C4', 'C5'].includes(process.argv[3])) throw new Error('WHOLE_C_ARGUMENTS');
  const config = require('./config').parse(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  await require('./core').run(config, process.argv[3]);
}
main().catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', name: error.name, code: error.code || 'WHOLE_C_INSTRUMENT_FAILURE' }) + '\n'); process.exitCode = 1; });
