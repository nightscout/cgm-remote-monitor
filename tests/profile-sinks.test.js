'use strict';

var moment = require('moment');
var should = require('should');
var cloneDeep = require('../lib/utils/clone');
var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

describe('profile-derived browser sinks', function () {
  var env;
  var state;
  var $;

  var profileNames = [
    'A&B'
    , 'A&amp;B'
    , '"><img src=x onerror="window.profileInjected=true">Unsafe'
  ];

  function setupDom (html) {
    // Some legacy DOM suites intentionally leave their window installed.
    // Remove it so jquery binds to this test's fresh, hermetic window.
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body>' + (html || '') + '</body></html>');
    state = domGlobals.installDomGlobals(env);
    $ = env.window.$;
    env.window.moment = moment;
  }

  function assertProfileOptions (selector) {
    var options = $(selector).find('option');

    options.length.should.equal(profileNames.length);
    options.map(function () { return $(this).val(); }).get().should.deepEqual(profileNames);
    options.eq(0).text().should.equal('A&B');
    options.eq(1).text().should.equal('A&B');
    options.eq(2).text().should.equal(profileNames[2]);
    env.document.querySelectorAll('script, [onerror]').length.should.equal(0);
    should(env.window.profileInjected).equal(undefined);
  }

  function makeProfile () {
    return {
      dia: 3
      , carbratio: [{time: '00:00', value: 10}]
      , carbs_hr: 20
      , delay: 20
      , sens: [{time: '00:00', value: 50}]
      , timezone: 'UTC'
      , perGIvalues: false
      , carbs_hr_high: 30
      , carbs_hr_medium: 30
      , carbs_hr_low: 30
      , delay_high: 15
      , delay_medium: 20
      , delay_low: 20
      , basal: [{time: '00:00', value: 1}]
      , target_low: [{time: '00:00', value: 90}]
      , target_high: [{time: '00:00', value: 110}]
      , startDate: '2025-01-01T00:00:00.000Z'
    };
  }

  afterEach(function () {
    [
      '../lib/client/boluscalc'
      , '../lib/client/careportal'
      , '../lib/profile/profileeditor'
      , '../lib/report_plugins/loopalyzer'
      , '../lib/report_plugins/profiles'
      , '../lib/report_plugins/treatments'
    ].forEach(function (moduleName) {
      delete require.cache[require.resolve(moduleName)];
    });
    domGlobals.restoreDomGlobals(state);
  });

  it('keeps care portal profile option values exact while rendering names as text', function () {
    setupDom('<select id="profile"></select>');

    var plugins = {
      getAllEventTypes: function () { return []; }
    };
    var client = {
      authorized: false
      , ctx: {moment: moment}
      , plugins: plugins
      , profilefunctions: {
        activeProfileToTime: function () { return profileNames[0]; }
        , listBasalProfiles: function () { return profileNames; }
      }
      , settings: {units: 'mg/dl'}
      , translate: function (value) { return value; }
      , utils: {}
    };

    var careportal = require('../lib/client/careportal')(client, $);
    careportal.prepare();

    assertProfileOptions('#profile');
    $('#profile').val().should.equal(profileNames[0]);
  });

  it('keeps bolus calculator profile option values exact while rendering names as text', function () {
    setupDom('<select id="bc_profile"></select><div id="bc_profileLabel"></div>');

    var plugins = function () { return {}; };
    var client = {
      browserUtils: {}
      , ctx: {moment: moment}
      , entries: []
      , plugins: plugins
      , profilefunctions: {
        activeProfileToTime: function () { return profileNames[0]; }
        , listBasalProfiles: function () { return profileNames; }
      }
      , sbx: {data: {food: []}}
      , settings: {
        enable: ['profile']
        , extendedSettings: {profile: {multiple: true}}
        , units: 'mg/dl'
      }
      , translate: function (value) { return value; }
      , utils: {}
    };

    var boluscalc = require('../lib/client/boluscalc')(client, $);
    boluscalc.eventTimeTypeChange = function () {};
    boluscalc.updateVisualisations = function () {};
    boluscalc.calculateInsulin = function () {};
    boluscalc.prepare();

    assertProfileOptions('#bc_profile');
    $('#bc_profile').val().should.equal(profileNames[0]);
  });

  it('renders profile report names and values as text', function () {
    setupDom(
      '<select id="profiles-databaserecords"></select>' +
      '<span id="profiles-default"></span>' +
      '<div id="profiles-chart"></div>'
    );

    var unsafeName = profileNames[2];
    var unsafeTime = '<svg onload="window.profileInjected=true">00:00</svg>';
    var record = makeProfile();
    record.units = 'Fish &amp; Chips &lt; 70';
    record.basal[0].time = unsafeTime;
    var store = {};
    store[unsafeName] = record;

    env.window.Nightscout = {
      client: {
        sbx: {
          data: {
            profile: {
              applyTimezone: function (value) { return value; }
            }
          }
        }
        , translate: function (value) { return value; }
      }
    };

    require('../lib/report_plugins/profiles')().report({
      profiles: [{
        defaultProfile: 'A&amp;B'
        , startDate: '2025-01-01T00:00:00.000Z'
        , store: store
      }]
    });

    $('#profiles-default').text().should.equal('A&B');
    $('#profiles-chart b').first().text().should.equal(unsafeName);
    $('#profiles-chart').text().should.containEql('Fish & Chips < 70');
    $('#profiles-chart').text().should.containEql(unsafeTime);
    $('#profiles-chart').find('img, svg, script, [onerror]').length.should.equal(0);
    should(env.window.profileInjected).equal(undefined);
  });

  it('renders loopalyzer profile names and range times as text', function () {
    setupDom('<div id="loopalyzer-profiles"></div>');

    var unsafeName = profileNames[2];
    var unsafeTime = '<img src=x onerror="window.profileInjected=true">00:00';
    var record = makeProfile();
    record.basal[0].time = unsafeTime;
    var store = {};
    store[unsafeName] = record;

    var profile = {
      applyTimezone: function (value) { return moment.utc(value); }
      , parseInTimezone: function (value) { return moment.utc(value); }
    };
    var client = {
      sbx: {data: {profile: profile}}
      , translate: function (value) { return value; }
    };

    require('../lib/report_plugins/loopalyzer')().renderProfilesTable([
      {
        startDate: '2024-12-31T00:00:00.000Z'
        , store: store
      }
    ], ['2025-01-01'], client);

    $('#loopalyzer-profiles-table caption').first().text().should.startWith(unsafeName);
    $('#loopalyzer-profiles-table').text().should.containEql(unsafeTime);
    $('#loopalyzer-profiles-table').find('img, script, [onerror]').length.should.equal(0);
    should(env.window.profileInjected).equal(undefined);
  });

  it('keeps treatment editor profile option values exact while rendering names as text', function () {
    setupDom('<div id="treatments-report"></div>');

    var client = {
      careportal: {
        events: []
        , resolveEventName: function (value) { return value; }
      }
      , profilefunctions: {
        listBasalProfiles: function () { return profileNames; }
      }
      , sbx: {
        data: {
          profile: {
            applyTimezone: function (value) { return value; }
            , parseInTimezone: function (value) { return moment(value); }
          }
        }
      }
      , settings: {timeFormat: 24, units: 'mg/dl'}
      , translate: function (value) { return value; }
      , utils: {}
    };
    var reportPlugins = {
      consts: {ORDER_NEWESTONTOP: 'newest'}
      , utils: {localeDate: function (value) { return value; }}
    };
    env.window.Nightscout = {client: client, report_plugins: reportPlugins};

    var plugin = require('../lib/report_plugins/treatments')();
    $('body').append(plugin.html(client));
    $.fn.dialog = function (options) {
      if (options && options.open) options.open.call(this[0]);
      return this;
    };

    plugin.report({
      '2025-01-01': {
        treatments: [{
          _id: 'treatment-id'
          , created_at: '2025-01-01T00:00:00.000Z'
          , eventType: 'Note'
        }]
      }
    }, ['2025-01-01'], {order: 'oldest', units: 'mg/dl'});
    $('.editTreatment').trigger('click');

    var options = $('#rped_profile option');
    options.length.should.equal(profileNames.length + 1);
    options.eq(0).val().should.equal('');
    options.slice(1).map(function () { return $(this).val(); }).get().should.deepEqual(profileNames);
    options.eq(1).text().should.equal('A&B');
    options.eq(2).text().should.equal('A&B');
    options.eq(3).text().should.equal(profileNames[2]);
    env.document.querySelectorAll('script, [onerror]').length.should.equal(0);
    should(env.window.profileInjected).equal(undefined);
  });

  it('keeps profile editor option values exact while rendering names as text', function () {
    setupDom(
      '<select id="pe_profiles"></select>' +
      '<select id="pe_timezone"></select>' +
      '<select id="pe_databaserecords"></select>' +
      '<input id="pe_time"><input id="pe_date">' +
      '<div id="pe_basal_placeholder"></div>' +
      '<div id="pe_ic_placeholder"></div>' +
      '<div id="pe_isf_placeholder"></div>' +
      '<div id="pe_targetbg_placeholder"></div>'
    );

    var store = {};
    profileNames.forEach(function (name) {
      store[name] = makeProfile();
    });
    var record = {
      defaultProfile: profileNames[0]
      , startDate: '2025-01-01T00:00:00.000Z'
      , store: store
    };
    var profilefunctions = {
      data: []
      , loadData: function (records) { this.data = records; }
    };
    var client = {
      ctx: {moment: moment, timezones: ['UTC']}
      , headers: function () { return {}; }
      , init: function (callback) { callback(); }
      , profilefunctions: profilefunctions
      , settings: {
        customTitle: 'Nightscout'
        , extendedSettings: {profile: {history: true, multiple: true}}
        , timeFormat: 24
        , units: 'mg/dl'
      }
      , translate: function (value) { return value; }
      , utils: {cloneDeep: cloneDeep}
    };
    env.window.Nightscout = {client: client};
    $.ajax = function (url, options) {
      options.success([record]);
      return {
        done: function (callback) {
          callback();
          return this;
        }
      };
    };

    require('../lib/profile/profileeditor')();

    assertProfileOptions('#pe_profiles');
    $('#pe_profiles').val().should.equal(profileNames[0]);
  });
});
