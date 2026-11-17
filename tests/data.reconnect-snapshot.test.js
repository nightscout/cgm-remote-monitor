'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const http = require('node:http');
const ioClient = require('socket.io-client');
const moment = require('moment');
const makeData = require('../lib/data/ddata');
const receiveDData = require('../lib/client/receiveddata');

function copy (value) {
  return JSON.parse(JSON.stringify(value));
}

function nextEvent (emitter, event) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      emitter.removeListener(event, received);
      reject(new Error('Timed out waiting for ' + event));
    }, 3000);
    function received (value) {
      clearTimeout(timer);
      resolve(value);
    }
    emitter.once(event, received);
  });
}

describe('Completed data snapshots on reconnect', function () {
  it('reads every reconnect field from the completed snapshot while live arrays are replaced', function () {
    const live = makeData();
    live.devicestatus = [{ _id: 'status', mills: Date.now() - 1000, device: 'rig', pump: {} }];
    live.sgvs = [{ mgdl: 100 }];
    live.cals = [{ slope: 1 }];
    live.mbgs = [{ mgdl: 110 }];
    live.food = [{ name: 'food' }];
    live.treatments = [{ eventType: 'Bolus', insulin: 1 }];
    live.dbstats = { dataSize: 100 };
    live.profiles = [{ store: { default: { dia: 3 }, 'default@@@@@temporary': { dia: 4 } } }];
    const snapshot = live.clone();

    // The loader replaces these arrays in separate asynchronous callbacks.
    ['devicestatus', 'sgvs', 'cals', 'mbgs', 'food', 'treatments', 'profiles'].forEach(function (field) {
      live[field] = [];
    });
    live.dbstats = {};

    const payload = snapshot.dataWithRecentStatuses();
    ['devicestatus', 'sgvs', 'cals', 'mbgs', 'food', 'treatments', 'dbstats'].forEach(function (field) {
      assert.deepEqual(payload[field], snapshot[field], field);
    });
    assert.deepEqual(payload.profiles, [{ store: { default: { dia: 3 } } }]);
    assert.ok(snapshot.profiles[0].store['default@@@@@temporary'], 'Profile cleanup must not mutate the snapshot');
    assert.deepEqual(live.dataWithRecentStatuses().devicestatus, [], 'Live calls still use live data');
  });

  it('keeps the recent-status cutoff, per-device/type limit and deduplication on a snapshot', function () {
    const live = makeData();
    const at = Date.now();
    const statuses = Array.from({ length: 12 }, function (_, index) {
      return { _id: 'pump-' + index, mills: at - (12 - index) * 1000,
        device: 'pump', pump: {}, uploader: {} };
    });
    const other = { _id: 'aps', mills: at, device: 'aps', openaps: {} };
    const future = { _id: 'future', mills: at + 1000, device: 'pump', pump: {} };
    live.devicestatus = statuses.concat([other, future]);
    const snapshot = live.clone();
    live.devicestatus = [];

    assert.deepEqual(snapshot.recentDeviceStatus(at), statuses.slice(2).concat([other]));
    assert.deepEqual(live.recentDeviceStatus(at), []);
  });

  it('preserves device IOB when a polling client reconnects during a dataloader refresh', async function () {
    this.timeout(10000);
    const at = Date.now();
    const rawEntries = [{ _id: 'glucose', date: at - 120000, sgv: 100, type: 'sgv' }];
    const rawTreatments = [{ _id: 'bolus', created_at: new Date(at).toISOString(), eventType: 'Bolus', insulin: 6.5 }];
    let rawStatuses = [{ _id: 'status', created_at: new Date(at - 120000).toISOString(), device: 'rig',
      openaps: { iob: { iob: 1.25, time: new Date(at - 120000).toISOString() } } }];
    const settings = { enable: [], isEnabled: function () { return false; },
      extendedSettings: { devicestatus: { advanced: true } } };
    const language = { translate: function (text) { return text; } };
    const iob = require('../lib/plugins/iob')({ moment: moment, language: language });
    const profile = { getDIA: function () { return 3; }, getSensitivity: function () { return 0; } };
    const env = { settings: settings, extendedSettings: settings.extendedSettings,
      name: 'test', version: '0.0.0', enclave: { isApiKeySet: function () { return true; } },
      entries_collection: 'entries', treatments_collection: 'treatments', devicestatus_collection: 'devicestatus',
      profile_collection: 'profile', activity_collection: 'activity', food_collection: 'food' };
    let holdStatus = false;
    let releaseStatus;
    const ctx = {
      ddata: makeData(), bus: new EventEmitter(), settings: settings, language: language,
      authorization: {
        resolve: function (_credentials, callback) { callback(null, { shiros: ['read'] }); },
        checkMultiple: function (permission) { return permission === 'api:*:read'; }
      },
      cache: {
        isEmpty: function () { return true; },
        getRemovalGeneration: function () { return 0; },
        insertData: function (_collection, data) { return copy(data); },
        insertDataRef: function (_collection, data) { return copy(data); }
      },
      entries: { list: function (_query, callback) { callback(null, copy(rawEntries)); } },
      treatments: { list: function (query, callback) { callback(null, query.find.eventType ? [] : copy(rawTreatments)); } },
      devicestatus: { list: function (_query, callback) {
        if (holdStatus) releaseStatus = function () { callback(null, copy(rawStatuses)); };
        else callback(null, copy(rawStatuses));
      } },
      profile: { last: function (callback) { callback(null, [{ dia: 3 }]); } },
      food: { list: function (callback) { callback(null, []); } },
      activity: { list: function (_query, callback) { callback(null, []); } },
      store: { db: { stats: function () { return Promise.resolve({ dataSize: 1, indexSize: 1 }); } } }
    };
    const loader = require('../lib/data/dataloader')(env, ctx);
    function reload () {
      return new Promise(function (resolve, reject) {
        loader.update(ctx.ddata, function (error) { if (error) reject(error); else resolve(); });
      });
    }
    await reload();
    const browser = makeData();
    const server = http.createServer();
    require('../lib/server/websocket')(env, ctx, server);
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    ctx.bus.emit('data-processed');
    let socket;
    let loading;
    async function reconnect () {
      if (socket) socket.disconnect();
      socket = ioClient('http://127.0.0.1:' + server.address().port,
        { transports: ['polling'], reconnection: false, forceNew: true });
      await nextEvent(socket, 'connect');
      const payload = nextEvent(socket, 'dataUpdate');
      socket.emit('authorize', { client: 'web' });
      return payload;
    }
    function displayedIOB (payload) {
      receiveDData(payload, browser, settings);
      const result = iob.calcTotal(browser.treatments, browser.devicestatus, profile, at);
      let pill;
      iob.updateVisualisation({ properties: { iob: result },
        roundInsulinForDisplayFormat: function (value) { return Number(value).toFixed(2); },
        pluginBase: { updatePillText: function (_plugin, text) { pill = text.value; } } });
      return pill;
    }
    try {
      assert.equal(displayedIOB(await reconnect()), '1.25U');
      assert.equal(displayedIOB({ delta: true, sgvs: copy(browser.sgvs) }), '1.25U');
      holdStatus = true;
      loading = reload();
      assert.ok(releaseStatus, 'The real loader is waiting for device statuses');
      assert.equal(ctx.ddata.devicestatus.length, 0);
      assert.equal(ctx.ddata.treatments.length, 1);

      // The reconnect must use the previous complete snapshot, not publish
      // the live empty list and make the browser display 6.50U instead.
      assert.equal(displayedIOB(await reconnect()), '1.25U');
      assert.equal(browser.devicestatus.length, 1);
      assert.equal(browser.sgvs[0].mgdl, 100);
      releaseStatus();
      releaseStatus = null;
      await loading;
      ctx.bus.emit('data-processed');
      assert.equal(displayedIOB(await reconnect()), '1.25U');

      // A completed refresh with no device statuses must still be honoured.
      // This fix must not hide genuinely missing data behind a cached IOB.
      holdStatus = false;
      rawStatuses = [];
      await reload();
      ctx.bus.emit('data-processed');
      assert.equal(displayedIOB(await reconnect()), '6.50U');
      assert.equal(browser.devicestatus.length, 0);
    } finally {
      if (releaseStatus) releaseStatus();
      if (loading) await loading;
      if (socket) socket.disconnect();
      ctx.bus.emit('teardown');
      await new Promise(function (resolve) { server.close(resolve); });
    }
  });
});
