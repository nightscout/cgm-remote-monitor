'use strict';

const assert = require('assert');
const moment = require('moment-timezone');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const globals = require('./fixtures/dom-globals');

describe('Profile editor with nothing stored', function () {
  let state, env, $, writes, alerts;

  function openEditor (respond) {
    delete global.window;
    delete global.document;
    env = createSecureDOM('<html><body><form id="pe_form"><button type="button">Save</button></form>' +
      '<span class="pe_status"></span>' +
      '<select id="pe_profiles"></select><select id="pe_timezone"></select>' +
      '<select id="pe_databaserecords"></select>' +
      ['pe_time', 'pe_date', 'pe_profile_name', 'pe_dia', 'pe_hr'].map(id => '<input id="' + id + '">').join('') +
      ['pe_basal_placeholder', 'pe_ic_placeholder', 'pe_isf_placeholder', 'pe_targetbg_placeholder'].map(id => '<div id="' + id + '"></div>').join('') +
      '</body></html>');
    state = globals.installDomGlobals(env);
    $ = env.window.$;
    $.fx.off = true;
    writes = [];
    alerts = [];
    env.window.alert = message => alerts.push(message);
    env.window.Nightscout = { client: {
      ctx: { moment, timezones: ['UTC'] },
      headers: () => ({}), init: callback => callback(),
      hashauth: { isAuthenticated: () => true },
      profilefunctions: require('../lib/profilefunctions')(null, { moment }),
      settings: { customTitle: 'Test', units: 'mg/dl', timeFormat: 24,
        extendedSettings: { profile: { history: true, multiple: true } } },
      translate: value => value,
      utils: { cloneDeep: value => JSON.parse(JSON.stringify(value)),
        mergeInputTime: (time, date) => date + 'T' + time + ':00Z' }
    } };
    $.ajax = function (url, options) {
      if (typeof url === 'object') {
        writes.push(JSON.parse(url.data));
        return { done: function () { return this; }, fail: function () { return this; } };
      }
      respond(options);
      return { done: function (callback) { callback(); return this; } };
    };
    require('../lib/profile/profileeditor')();
  }

  afterEach(function () {
    delete require.cache[require.resolve('../lib/profile/profileeditor')];
    globals.restoreDomGlobals(state);
  });

  it('reports that defaults are in use when no record is stored', function () {
    openEditor(options => options.success([]));
    assert.strictEqual($('.pe_status').text(), 'Default values used.');
    assert.strictEqual($('#pe_dia').val(), '3');
    assert.strictEqual(writes.length, 0);
  });
});
