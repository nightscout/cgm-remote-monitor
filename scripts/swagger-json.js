#!/usr/bin/env node

'use strict';

// Each OpenAPI document is kept as YAML and served as YAML and as JSON. The
// YAML file is the one to edit; this script writes its JSON twin.
//
//   node scripts/swagger-json.js          write both swagger.json files
//   node scripts/swagger-json.js --check  exit 1 if either is out of date
//
// tests/api-docs.contract.test.js runs the same comparison.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DOCUMENTS = ['lib/server/swagger.yaml', 'lib/api3/swagger.yaml'];

function render (yamlFile) {
  const source = fs.readFileSync(yamlFile, 'utf8');
  return JSON.stringify(yaml.load(source), null, 2) + '\n';
}

function jsonFile (yamlFile) {
  return yamlFile.replace(/\.yaml$/, '.json');
}

function main (argv) {
  const root = path.resolve(__dirname, '..');
  const check = argv.includes('--check');
  let stale = 0;
  for (const relative of DOCUMENTS) {
    const yamlFile = path.join(root, relative);
    const expected = render(yamlFile);
    const target = jsonFile(yamlFile);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (actual === expected) continue;
    if (check) {
      console.error(path.relative(root, target) + ' is out of date; run node scripts/swagger-json.js');
      stale++;
    } else {
      fs.writeFileSync(target, expected);
      console.log('wrote ' + path.relative(root, target));
    }
  }
  return stale ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {DOCUMENTS, render, jsonFile};
