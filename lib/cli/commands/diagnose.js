'use strict';

// `nightscout diagnose data [--limit N]` runs scripts/diagnose-data.js, the
// read-only aggregate report. The script reads MONGODB_URI (or
// CUSTOMCONNSTR_mongo); run here, against a deployed site, it also finds the
// database the way the server does (STORAGE_URI, MONGO_CONNECTION, MONGO,
// MONGOLAB_URI, MONGODB_URI, each also as CUSTOMCONNSTR_), so an operator
// does not have to restate it.

const EX_USAGE = 64;
const envValue = require('../../utils/env-value');

const STORAGE_NAMES = ['STORAGE_URI', 'MONGO_CONNECTION', 'MONGO', 'MONGOLAB_URI', 'MONGODB_URI'];

function storageURI (source) {
  const normalized = {};
  for (const [key, value] of Object.entries(source)) normalized[key.trim()] = String(value).trim();
  for (const name of STORAGE_NAMES) {
    const value = envValue(normalized, name);
    if (value) return value;
  }
  return undefined;
}

function run (args, io) {
  const [target, ...rest] = args;
  if (target !== 'data') {
    io.stderr.write('Usage: nightscout diagnose data [--limit N]\n');
    return EX_USAGE;
  }
  const uri = storageURI(io.env);
  if (uri) process.env.MONGODB_URI = uri;
  return require('../../../scripts/diagnose-data').run(rest);
}

module.exports = { run, storageURI };
