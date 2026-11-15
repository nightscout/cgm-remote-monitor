'use strict';

const assert = require('assert');
const moment = require('moment-timezone');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const globals = require('./fixtures/dom-globals');

describe('Profile editor loading and incomplete values', function () {
  let state, env, $, writes, alerts;

  function openEditor (respond) {
    delete global.window;
    delete global.document;
    env = createSecureDOM('<html><body><form id="pe_form"><button type="submit">Save</button>' +
      '<span class="pe_status"></span>' +
      '<select id="pe_profiles"></select><select id="pe_timezone"></select>' +
      '<select id="pe_databaserecords"></select>' +
      ['pe_time', 'pe_date', 'pe_profile_name', 'pe_dia', 'pe_hr'].map(id => '<input id="' + id + '">').join('') +
      ['pe_basal_placeholder', 'pe_ic_placeholder', 'pe_isf_placeholder', 'pe_targetbg_placeholder'].map(id => '<div id="' + id + '"></div>').join('') +
      '</form></body></html>');
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
        return $.Deferred().promise();
      }
      const deferred = $.Deferred();
      deferred.done(options.success).fail(options.error);
      respond(deferred);
      return deferred.promise();
    };
    require('../lib/profile/profileeditor')();
  }

  afterEach(function () {
    delete require.cache[require.resolve('../lib/profile/profileeditor')];
    globals.restoreDomGlobals(state);
  });

  it('reports that defaults are in use when no record is stored', function () {
    openEditor(response => response.resolve([]));
    assert.strictEqual($('.pe_status').text(), 'Default values used.');
    assert.strictEqual($('#pe_dia').val(), '3');
    assert.strictEqual(writes.length, 0);
  });

  it('keeps editing and submission disabled until the fetch succeeds', function () {
    let response;
    openEditor(pending => { response = pending; });
    assert.strictEqual($('#pe_form :input:enabled').length, 0);
    const submit = $.Event('submit');
    $('#pe_form').trigger(submit);
    assert.strictEqual(submit.isDefaultPrevented(), true);
    assert.strictEqual(writes.length, 0);
    response.resolve([]);
    assert.strictEqual($('#pe_dia').prop('disabled'), false);
    assert.strictEqual($('#pe_form button').prop('disabled'), false);
    assert.strictEqual($('#pe_dia').val(), '3');
  });

  it('keeps the editor disabled without inventing a profile after a failed fetch', function () {
    openEditor(response => response.reject());
    assert.strictEqual($('.pe_status').text(), 'Your profile could not be loaded. Reload before editing.');
    assert.strictEqual($('#pe_dia').val(), '');
    assert.strictEqual($('#pe_profiles option').length, 0);
    assert.strictEqual($('#pe_basal_val_0').length, 0);
    assert.strictEqual($('#pe_form :input:enabled').length, 0);
    const submit = $.Event('submit');
    $('#pe_form').trigger(submit);
    assert.strictEqual(submit.isDefaultPrevented(), true);
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(alerts, []);
  });

  it('refuses to save while a clinical field is still empty', function () {
    openEditor(response => response.resolve([]));
    $('#pe_dia').val('');
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(alerts, ['Enter every profile value before saving.']);
  });

  it('saves normally once every field carries a value', function () {
    openEditor(response => response.resolve([]));
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(alerts.length, 0);
  });

  it('preserves fetched values and allows saving an existing profile', function () {
    const profile = require('../lib/client-core').profileEditor.buildDefaultProfile();
    profile.dia = 5;
    openEditor(response => response.resolve([{
      defaultProfile: 'Existing', store: { Existing: profile },
      startDate: '2026-01-01T00:00:00Z'
    }]));
    assert.strictEqual($('.pe_status').text(), 'Values loaded.');
    assert.strictEqual($('#pe_dia').val(), '5');
    assert.strictEqual($('#pe_form button').prop('disabled'), false);
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].store.Existing.dia, 5);
  });
});
