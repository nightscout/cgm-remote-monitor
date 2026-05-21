'use strict';

/*
 * Phase 3.3 — admintools modern jsdom test
 *
 * Replaces tests/admintools.test.js (benv + bundle.app.js).
 * Exercises each lib/admin_plugins/* factory directly against jsdom + jQuery.
 * Same 14 status-text assertions as the legacy test, organized per plugin.
 */

require('should');
const moment = require('moment');
const { createSecureDOM } = require('./fixtures/secure-jsdom');
const { installDomGlobals, restoreDomGlobals } = require('./fixtures/dom-globals');

function makeTranslate () {
  return function translate (s, opts) {
    let r = s;
    if (opts && opts.params) {
      opts.params.forEach((v, i) => { r = r.replace('%' + (i + 1), v); });
    }
    return r;
  };
}

// Renders the per-action <div ...html> + <span ...status> containers the
// production plugins look up by id. Mirrors lib/admin_plugins/index.js
// createHTML() but without dependencies on the rest of the client.
function renderPluginContainers (plugin, $) {
  const fs = $('<fieldset>');
  $('body').append(fs);
  for (let i = 0; i < plugin.actions.length; i++) {
    fs.append($('<div>').attr('id', 'admin_' + plugin.name + '_' + i + '_html'));
    fs.append($('<span>').attr('id', 'admin_' + plugin.name + '_' + i + '_status'));
  }
}

// Synchronous ajax mock matching the URL-prefix routing used by the
// legacy test. Success path always invokes opts.success then .done().
function makeAjax (routes) {
  return function $ajax (url, opts) {
    if (url && typeof url === 'object') { opts = url; url = url.url; }
    let key = url;
    Object.keys(routes).forEach((k) => { if (url && url.indexOf(k) === 0) key = k; });
    const data = routes[key];
    if (opts && opts.success && data !== undefined) opts.success(data);
    return {
      done (fn) { if (fn) fn(); return $ajax('', {}); },
      fail (fn) { return $ajax('', {}); }
    };
  };
}

function makeClient () {
  return {
    translate: makeTranslate(),
    headers: () => ({}),
    hashauth: { isAuthenticated: () => true },
    careportal: { resolveEventName: (n) => n }
  };
}

describe('admintools (modern jsdom)', function () {
  let env, $, state, client;

  beforeEach(function () {
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = installDomGlobals(env);
    $ = env.window.$;
    // Strip jQuery effects so status text is observable synchronously.
    $.fn.hide = function () { return this; };
    $.fn.fadeIn = function () { return this; };
    env.window.alert = () => true;
    env.window.confirm = () => true;
    client = makeClient();
  });

  afterEach(function () {
    restoreDomGlobals(state);
    [
      '../lib/admin_plugins/cleanstatusdb',
      '../lib/admin_plugins/cleantreatmentsdb',
      '../lib/admin_plugins/cleanentriesdb',
      '../lib/admin_plugins/futureitems'
    ].forEach((p) => { delete require.cache[require.resolve(p)]; });
  });

  describe('cleanstatusdb', function () {
    let plugin;
    beforeEach(function () {
      plugin = require('../lib/admin_plugins/cleanstatusdb')({ moment });
      renderPluginContainers(plugin, $);
    });

    it('action[0]: counts devicestatus records on init then reports removal on code()', function () {
      $.ajax = makeAjax({
        '/api/v1/devicestatus.json?count=500': [{ _id: 'a' }, { _id: 'b' }],
        '/api/v1/devicestatus/*': { ok: true }
      });
      plugin.actions[0].init(client);
      $('#admin_cleanstatusdb_0_status').text().should.equal('Database contains 2 records');
      plugin.actions[0].buttonLabel.should.equal('Delete all documents');

      plugin.actions[0].code(client);
      $('#admin_cleanstatusdb_0_status').text().should.equal('All records removed ...');
    });

    it('action[1]: renders day-input on init then deletes on code()', function () {
      $.ajax = makeAjax({
        '/api/v1/devicestatus/?find[created_at][$lte]=': { n: 1 }
      });
      plugin.actions[1].init(client);
      $('#admin_cleanstatusdb_1_status').text().should.equal('');
      plugin.actions[1].buttonLabel.should.equal('Delete old documents');
      $('#admin_devicestatus_days').length.should.equal(1);

      plugin.actions[1].code(client);
      $('#admin_cleanstatusdb_1_status').text().should.equal('1 records deleted');
    });
  });

  describe('futureitems', function () {
    let plugin;
    beforeEach(function () {
      plugin = require('../lib/admin_plugins/futureitems')({ moment });
      renderPluginContainers(plugin, $);
    });

    it('action[0]: lists future treatments then reports removal on code()', function () {
      $.ajax = makeAjax({
        '/api/v1/treatments.json?&find[created_at][$gte]=': [
          { _id: '5609a9203c8104a8195b1c1e', eventType: 'Carb Correction', carbs: 3, created_at: '2025-09-28T20:54:00.000Z' }
        ],
        '/api/v1/treatments/5609a9203c8104a8195b1c1e': { ok: true }
      });
      plugin.actions[0].init(client);
      $('#admin_futureitems_0_status').text().should.equal('Database contains 1 future records');
      plugin.actions[0].buttonLabel.should.equal('Remove treatments in the future');

      plugin.actions[0].code(client);
      $('#admin_futureitems_0_status').text().should.equal('Record 5609a9203c8104a8195b1c1e removed ...');
    });

    it('action[1]: lists future entries then reports removal on code()', function () {
      $.ajax = makeAjax({
        '/api/v1/entries.json?&find[date][$gte]=': [
          { _id: '560983f326c5a592d9b9ae0c', date: 1543464149000, sgv: 83 }
        ],
        '/api/v1/entries/560983f326c5a592d9b9ae0c': { ok: true }
      });
      plugin.actions[1].init(client);
      $('#admin_futureitems_1_status').text().should.equal('Database contains 1 future records');
      plugin.actions[1].buttonLabel.should.equal('Remove entries in the future');

      plugin.actions[1].code(client);
      $('#admin_futureitems_1_status').text().should.equal('Record 560983f326c5a592d9b9ae0c removed ...');
    });
  });

  describe('cleantreatmentsdb', function () {
    it('action[0]: renders day-input on init then deletes on code()', function () {
      const plugin = require('../lib/admin_plugins/cleantreatmentsdb')({ moment });
      renderPluginContainers(plugin, $);
      $.ajax = makeAjax({
        '/api/v1/treatments/?find[created_at][$lte]=': { n: 1 }
      });
      plugin.actions[0].init(client);
      $('#admin_cleantreatmentsdb_0_status').text().should.equal('');
      plugin.actions[0].buttonLabel.should.equal('Delete old documents');

      plugin.actions[0].code(client);
      $('#admin_cleantreatmentsdb_0_status').text().should.equal('1 records deleted');
    });
  });

  describe('cleanentriesdb', function () {
    it('action[0]: renders day-input on init then deletes on code()', function () {
      const plugin = require('../lib/admin_plugins/cleanentriesdb')({ moment });
      renderPluginContainers(plugin, $);
      $.ajax = makeAjax({
        '/api/v1/entries/?find[date][$lte]=': { n: 1 }
      });
      plugin.actions[0].init(client);
      $('#admin_cleanentriesdb_0_status').text().should.equal('');
      plugin.actions[0].buttonLabel.should.equal('Delete old documents');

      plugin.actions[0].code(client);
      $('#admin_cleanentriesdb_0_status').text().should.equal('1 records deleted');
    });
  });
});
