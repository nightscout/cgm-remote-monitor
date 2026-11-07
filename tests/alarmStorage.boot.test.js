'use strict';
require('should');

// Boots the server against a real MongoDB and checks that alarm snooze storage
// is wired in, and that it stays off when another site could share its name.
// Skipped when no connection string is configured.
var uri = process.env.STORAGE_URI || process.env.MONGO_CONNECTION || process.env.MONGO ||
  process.env.MONGODB_URI;

(uri ? describe : describe.skip)('alarm snooze storage at boot', function () {
  this.timeout(60000);

  async function bootWith (change) {
    var originalSecret = process.env.API_SECRET;
    process.env.API_SECRET = 'alarm storage boot test secret';
    try {
      var env = require('../lib/server/env')();
      env.IMPORT_CONFIG = null;
      env.extendedSettings.connect = {};
      env.extendedSettings.bridge = {};
      env.extendedSettings.mmconnect = {};
      change(env);
      var boot = require('../lib/server/bootevent');
      var ctx = await new Promise(function (resolve) {
        boot(env, require('../lib/language')()).boot(resolve);
      });
      ctx.env = env;
      return ctx;
    } finally {
      if (originalSecret === undefined) delete process.env.API_SECRET;
      else process.env.API_SECRET = originalSecret;
    }
  }

  async function hasTtlIndex (ctx, name) {
    for (var attempt = 0; attempt < 50; attempt++) {
      var indexes = await ctx.store.db.collection(name).indexes().catch(function () { return []; });
      var ttl = indexes.filter(function (index) { return index.key.expiresAt === 1; });
      if (ttl.length === 1 && ttl[0].expireAfterSeconds === 0) return true;
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
    return false;
  }

  it('binds alarm storage and creates its TTL index in the configured collection', async function () {
    var ctx = await bootWith(function (env) { env.alarmsnooze_collection = 'boot_test_alarmsnooze'; });
    try {
      (typeof ctx.alarmStorage.getSnooze).should.equal('function');
      (await hasTtlIndex(ctx, 'boot_test_alarmsnooze')).should.equal(true);
    } finally {
      await ctx.store.db.collection('boot_test_alarmsnooze').drop().catch(function () {});
      ctx.bus.teardown();
    }
  });

  it('leaves sharing off when ALARM_SNOOZE_SHARING is off', async function () {
    var ctx = await bootWith(function (env) { env.alarm_snooze_sharing = false; });
    try {
      (ctx.alarmStorage === undefined).should.equal(true);
    } finally {
      ctx.bus.teardown();
    }
  });

  it('leaves sharing off when another collection is renamed and the snooze one is not', async function () {
    var ctx = await bootWith(function (env) { env.treatments_collection = 'boot_test_treatments'; });
    try {
      (ctx.alarmStorage === undefined).should.equal(true);
    } finally {
      await ctx.store.db.collection('boot_test_treatments').drop().catch(function () {});
      ctx.bus.teardown();
    }
  });
});
