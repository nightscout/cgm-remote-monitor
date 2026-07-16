'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_DIR = path.resolve(__dirname, '../../node_modules/.cache/_ns_cache');
const SECRET_FILE = 'telemetrySecret';
const COUNTERS_FILE = 'telemetryCounters.json';
const SCHEDULE_FILE = 'telemetrySchedule.json';
const DOC_ID = 'nightscout-telemetry';

function createStore (options) {
  if (typeof options === 'string' || !options) {
    options = { storeDir: options };
  }
  options = options || {};
  var storeDir = options.storeDir || DEFAULT_STORE_DIR;
  var collectionName = options.collection || 'telemetry';
  var mongoCollection = options.mongoStore && typeof options.mongoStore.collection === 'function'
    ? options.mongoStore.collection(collectionName)
    : null;
  var state = {};
  var loaded = !mongoCollection;

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

  var ready = mongoCollection
    ? mongoCollection.findOne({ _id: DOC_ID }).then(function onLoaded (doc) {
      state = doc || {};
      loaded = true;
      return state;
    }).catch(function onFailed () {
      state = {};
      loaded = true;
      return state;
    })
    : Promise.resolve(state);

  function persistMongo () {
    if (!mongoCollection) {
      return;
    }
    var doc = Object.assign({}, state, {
      _id: DOC_ID,
      updated_at: new Date().toISOString()
    });
    mongoCollection.replaceOne({ _id: DOC_ID }, doc, { upsert: true }).catch(function ignore () {});
  }

  function readOrCreateSecret () {
    if (state.secret) {
      return state.secret;
    }
    if (mongoCollection && !loaded) {
      throw new Error('telemetry mongo store is not ready');
    }
    try {
      if (!mongoCollection || options.storeDir) {
        var existing = readText(SECRET_FILE);
        if (existing) {
          state.secret = existing;
          persistMongo();
          return existing;
        }
      }
    } catch (err) {
      // Missing file is expected on first run.
    }
    var generated = crypto.randomBytes(32).toString('base64url');
    state.secret = generated;
    persistMongo();
    if (!mongoCollection || options.storeDir) {
      writeText(SECRET_FILE, generated);
    }
    return generated;
  }

  return {
    storeDir,
    collectionName,
    ready,
    readOrCreateSecret,
    readCounters: function readCounters () {
      if (state.counters) {
        return state.counters;
      }
      if (mongoCollection && !options.storeDir) {
        return null;
      }
      return readJson(COUNTERS_FILE);
    },
    writeCounters: function writeCounters (state) {
      thisState().counters = state;
      persistMongo();
      if (!mongoCollection || options.storeDir) {
        writeJson(COUNTERS_FILE, state);
      }
    },
    readSchedule: function readSchedule () {
      if (state.schedule) {
        return state.schedule;
      }
      if (mongoCollection && !options.storeDir) {
        return null;
      }
      return readJson(SCHEDULE_FILE);
    },
    writeSchedule: function writeSchedule (state) {
      thisState().schedule = state;
      persistMongo();
      if (!mongoCollection || options.storeDir) {
        writeJson(SCHEDULE_FILE, state);
      }
    }
  };

  function thisState () {
    state = state || {};
    return state;
  }
}

createStore.DEFAULT_STORE_DIR = DEFAULT_STORE_DIR;
createStore.DOC_ID = DOC_ID;

module.exports = createStore;
