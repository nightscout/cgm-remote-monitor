'use strict';
const assert = require('assert');
const moment = require('moment-timezone');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const globals = require('./fixtures/dom-globals');
const fixture = require('./fixtures/unnamed-profile.json');
const clone = value => JSON.parse(JSON.stringify(value));

describe('Unnamed profile editor', function () {
  let state, env, $, writes, record;
  function openEditor(pointer) {
    record = clone(fixture);
    if (pointer !== undefined) record.defaultProfile = pointer;
    delete global.window;
    delete global.document;
    env = createSecureDOM('<html><body><form id="pe_form"><button type="button">Save</button></form>' +
      '<select id="pe_profiles"></select><select id="pe_timezone"></select>' +
      '<select id="pe_databaserecords"></select>' +
      ['pe_time', 'pe_date', 'pe_profile_name', 'pe_dia', 'pe_hr'].map(id => '<input id="' + id + '">').join('') +
      ['pe_basal_placeholder', 'pe_ic_placeholder', 'pe_isf_placeholder', 'pe_targetbg_placeholder'].map(id => '<div id="' + id + '"></div>').join('') +
      '</body></html>');
    state = globals.installDomGlobals(env);
    $ = env.window.$;
    $.fx.off = true;
    writes = [];
    env.window.alert = () => {};
    env.window.Nightscout = { client: {
      ctx: { moment, timezones: ['UTC'] },
      headers: () => ({}), init: callback => callback(),
      hashauth: { isAuthenticated: () => true },
      profilefunctions: require('../lib/profilefunctions')(null, { moment }),
      settings: { customTitle: 'Test', units: 'mmol', timeFormat: 24,
        extendedSettings: { profile: { history: true, multiple: true } } },
      translate: value => value,
      utils: { cloneDeep: clone, mergeInputTime: (time, date) => date + 'T' + time + ':00Z' }
    } };
    $.ajax = function (url, options) {
      if (typeof url === 'object') {
        assert.strictEqual(url.method, 'PUT');
        writes.push(JSON.parse(url.data));
        return { done: function () { return this; }, fail: function () { return this; } };
      }
      options.success([clone(record)]);
      return { done: function (callback) { callback(); return this; } };
    };
    require('../lib/profile/profileeditor')();
  }
  afterEach(function () {
    delete require.cache[require.resolve('../lib/profile/profileeditor')];
    globals.restoreDomGlobals(state);
  });
  it('loads the unnamed selection and correct values without writing', function () {
    openEditor();
    assert.deepStrictEqual($('#pe_profiles option').map(function () { return this.value; }).get(), ['', 'Named']);
    assert.strictEqual($('#pe_profiles').val(), '');
    assert.strictEqual($('#pe_profiles option').first().text(), '(unnamed)');
    assert.strictEqual($('#pe_dia').val(), '6');
    assert.strictEqual($('#pe_basal_val_0').val(), '0.5');
    assert.strictEqual($('#pe_isf_val_0').val(), '2.5');
    assert.strictEqual(writes.length, 0);
    assert.deepStrictEqual(record, fixture);
  });
  it('preserves the empty key and settings when saved unchanged', function () {
    openEditor();
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].defaultProfile, '');
    assert.deepStrictEqual(Object.keys(writes[0].store), ['', 'Named']);
    assert.strictEqual(writes[0].store[''].dia, 6);
    assert.strictEqual(writes[0].store[''].basal[0].value, 0.5);
    assert.strictEqual(writes[0].store[''].units, 'mmol');
  });
  it('renames explicitly without overwriting an existing profile', function () {
    openEditor();
    $('#pe_profile_name').val('Named');
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes[0].defaultProfile, 'Named1');
    assert.deepStrictEqual(Object.keys(writes[0].store), ['Named', 'Named1']);
    assert.strictEqual(writes[0].store.Named.dia, 5);
    assert.strictEqual(writes[0].store.Named1.dia, 6);
  });
  it('does not turn a named profile into a blank name', function () {
    openEditor('Named');
    $('#pe_profile_name').val('');
    $('#pe_form button').trigger('click');
    assert.strictEqual(writes[0].defaultProfile, 'Named');
    assert.deepStrictEqual(Object.keys(writes[0].store), ['', 'Named']);
    assert.strictEqual(writes[0].store.Named.dia, 5);
  });
  it('keeps both raw profiles in the Profile report', function () {
    openEditor();
    $('body').append('<select id="profiles-databaserecords"></select><span id="profiles-default"></span><div id="profiles-chart"></div>');
    env.window.moment = moment;
    env.window.Nightscout.client.sbx = { data: {
      profile: env.window.Nightscout.client.profilefunctions
    } };
    require('../lib/report_plugins/profiles')().report({ profiles: [clone(fixture)] });
    assert.strictEqual($('#profiles-chart > table > tr > td').length, 2);
    assert.ok($('#profiles-chart').text().includes('Named'));
    assert.strictEqual(writes.length, 0);
  });
  it('requires explicit selection for a dangling default pointer', function () {
    openEditor('Missing');
    assert.strictEqual($('#pe_form button').prop('disabled'), true);
    assert.strictEqual(writes.length, 0);
    $('#pe_profiles').val('').trigger('change');
    assert.strictEqual($('#pe_dia').val(), '6');
    assert.strictEqual($('#pe_form button').prop('disabled'), false);
  });
});
