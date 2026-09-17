#!/usr/bin/env node
'use strict';

/**
 * Generate (or refresh) pill-output goldens for every captured-fixture source.
 *
 * Usage:
 *   node tools/captured-fixtures/generate-pill-goldens.js          # dry-run, prints diff
 *   node tools/captured-fixtures/generate-pill-goldens.js --write  # writes pills-golden.json
 *
 * Output:
 *   tests/fixtures/captured/<source>/pills-golden.json
 *
 * Companion test: tests/client-core/pill-goldens.test.js
 */

const fs = require('fs');
const path = require('path');
const { captureRun, stableStringify, defaultSources } = require('./pill-runner');

const ROOT = path.resolve(__dirname, '..', '..');

function main () {
  const write = process.argv.includes('--write');
  const sources = defaultSources(ROOT);
  if (!sources.length) {
    console.error('No captured-fixture sources found under tests/fixtures/captured/');
    process.exit(1);
  }

  let drift = false;
  for (const sourceDir of sources) {
    const sourceName = path.basename(sourceDir);
    const goldenPath = path.join(sourceDir, 'pills-golden.json');
    let result;
    try {
      result = captureRun(sourceDir);
    } catch (e) {
      console.error(`[${sourceName}] FATAL: ${e.stack || e.message}`);
      process.exit(2);
    }
    const next = stableStringify(result);
    const prev = fs.existsSync(goldenPath) ? fs.readFileSync(goldenPath, 'utf8') : null;
    if (prev === next) {
      console.log(`[${sourceName}] unchanged`);
      continue;
    }
    drift = true;
    if (write) {
      fs.writeFileSync(goldenPath, next);
      console.log(`[${sourceName}] ${prev == null ? 'created' : 'updated'} ${path.relative(ROOT, goldenPath)}`);
    } else {
      console.log(`[${sourceName}] would ${prev == null ? 'create' : 'update'} ${path.relative(ROOT, goldenPath)}`);
      // Print a tiny preview of the new content so a CI log gives context.
      const preview = next.split('\n').slice(0, 12).join('\n');
      console.log(preview);
      console.log('  ...');
    }
  }

  if (drift && !write) {
    console.error('\nDrift detected. Re-run with --write to update goldens.');
    process.exit(1);
  }
}

main();
