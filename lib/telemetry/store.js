'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_DIR = path.resolve(__dirname, '../../node_modules/.cache/_ns_cache');
const SECRET_FILE = 'telemetrySecret';
const COUNTERS_FILE = 'telemetryCounters.json';

function createStore (storeDir) {
  storeDir = storeDir || DEFAULT_STORE_DIR;

  function ensureDir () {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  function readText (fileName) {
    return fs.readFileSync(path.join(storeDir, fileName), 'utf8').trim();
  }

  function writeText (fileName, value) {
    ensureDir();
    fs.writeFileSync(path.join(storeDir, fileName), value, { mode: 0o600 });
  }

  function readJson (fileName) {
    try {
      return JSON.parse(readText(fileName));
    } catch (err) {
      return null;
    }
  }

  function writeJson (fileName, value) {
    writeText(fileName, JSON.stringify(value, null, 2));
  }

  function readOrCreateSecret () {
    try {
      var existing = readText(SECRET_FILE);
      if (existing) {
        return existing;
      }
    } catch (err) {
      // Missing file is expected on first run.
    }
    var generated = crypto.randomBytes(32).toString('base64url');
    writeText(SECRET_FILE, generated);
    return generated;
  }

  return {
    storeDir,
    readOrCreateSecret,
    readCounters: function readCounters () {
      return readJson(COUNTERS_FILE);
    },
    writeCounters: function writeCounters (state) {
      writeJson(COUNTERS_FILE, state);
    }
  };
}

createStore.DEFAULT_STORE_DIR = DEFAULT_STORE_DIR;

module.exports = createStore;
