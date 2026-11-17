'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { selectBackend, schemeOf, knownSchemes, DEFAULT_BACKEND } = require('../lib/server/storage-backends');

// Records every specifier require() is asked for while fn runs.
function specifiersLoadedBy (fn) {
  const original = Module._load;
  const seen = [];
  Module._load = function (name) {
    seen.push(name);
    return original.apply(this, arguments);
  };
  try {
    fn();
  } finally {
    Module._load = original;
  }
  return seen;
}

describe('storage backend selection', function () {

  describe('from the connection URI', function () {

    it('selects mongodb for both MongoDB schemes, in any case', function () {
      assert.equal(selectBackend('mongodb://127.0.0.1:27017/nightscout').name, 'mongodb');
      assert.equal(selectBackend('mongodb+srv://cluster.example.net/nightscout').name, 'mongodb');
      assert.equal(selectBackend('MongoDB://127.0.0.1/ns').name, 'mongodb');
      assert.equal(schemeOf('MONGODB+SRV://host/ns'), 'mongodb+srv');
    });

    // mongo-storage and checkSettings already explain a missing or malformed
    // URI; a scheme error would replace their message with a worse one.
    it('falls back to mongodb when there is no scheme to read', function () {
      for (const uri of [undefined, null, '', '127.0.0.1:27017/nightscout', '//host:27017/ns']) {
        assert.equal(selectBackend(uri).name, DEFAULT_BACKEND, String(uri));
      }
    });

    it('refuses a scheme this build has no backend for, naming it and the ones it has, never the rest of the URI', function () {
      assert.throws(() => selectBackend('postgres://nightscout:planted-pw@db.example.invalid/ns'), function (err) {
        assert.equal(err.name, 'UnsupportedStorageBackendError');
        assert.match(err.message, /"postgres"/);
        for (const scheme of knownSchemes()) assert.ok(err.message.includes(scheme), err.message);
        assert.doesNotMatch(err.message, /planted-pw|db\.example\.invalid/);
        return true;
      });
    });
  });

  describe('what it loads', function () {

    // tests/runtime-policy.test.js treats the literal '../storage/mongo-storage'
    // as the sign that an application service loaded before the Node check. A
    // require(variable) here would retire that check without failing it.
    it('loads MongoDB through the specifier runtime-policy watches for', function () {
      const seen = specifiersLoadedBy(() => selectBackend('mongodb://127.0.0.1/ns').load());
      assert.ok(seen.includes('../storage/mongo-storage'), JSON.stringify(seen));
    });

    it('loads no backend until one is selected and asked for', function () {
      const id = require.resolve('../lib/server/storage-backends');
      const loaded = require.cache[id];
      delete require.cache[id];
      try {
        const seen = specifiersLoadedBy(() => require('../lib/server/storage-backends'));
        assert.ok(!seen.some(name => name.includes('mongo-storage')), JSON.stringify(seen));
      } finally {
        require.cache[id] = loaded;
      }
    });
  });

  describe('at boot', function () {
    this.timeout(10000);

    // The selector is worth something only if it gates boot: an unsupported
    // scheme leaves ctx.store undefined, and is reported as the configuration
    // mistake it is rather than as a failure to connect to MongoDB.
    it('refuses a scheme it has no backend for, before contacting any database', async function () {
      const boot = require('../lib/server/bootevent');
      const savedSecret = process.env.API_SECRET;
      process.env.API_SECRET = 'storage backend selection test secret';
      let ctx;
      try {
        const env = require('../lib/server/env')();
        env.IMPORT_CONFIG = null;
        env.storageURI = 'postgres://nightscout@127.0.0.1:5432/ns';
        const seen = [];
        const original = Module._load;
        Module._load = function (name) {
          seen.push(name);
          return original.apply(this, arguments);
        };
        try {
          ctx = await new Promise(resolve => boot(env, require('../lib/language')()).boot(resolve));
        } finally {
          Module._load = original;
        }
        assert.ok(!seen.includes('../storage/mongo-storage'), 'loaded the MongoDB backend');
      } finally {
        if (savedSecret === undefined) delete process.env.API_SECRET; else process.env.API_SECRET = savedSecret;
      }
      try {
        const error = ctx.bootErrors.find(e => e.desc === 'Unsupported storage backend');
        assert.ok(error, JSON.stringify(ctx.bootErrors));
        assert.match(error.err, /"postgres"/);
        assert.ok(!ctx.bootErrors.some(e => e.desc === 'Unable to connect to Mongo'), JSON.stringify(ctx.bootErrors));
        assert.equal(ctx.store, undefined);
      } finally {
        if (ctx && ctx.bus && ctx.bus.teardown) ctx.bus.teardown();
      }
    });
  });
});
