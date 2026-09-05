'use strict';

require('should');

var moment = require('moment');
var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

describe('report page reconnect initialization', function () {
  var env;
  var state;
  var $;

  beforeEach(function () {
    env = createSecureDOM(
      '<!DOCTYPE html><html><head></head><body>' +
      '<ul id="tabnav"><li id="first" class="menutab selected">First</li>' +
      '<li id="second" class="menutab">Second</li></ul>' +
      '<div id="pluginchartplaceholders"></div>' +
      '<button id="rp_show">Show</button>' +
      '<input id="rp_from"><input id="rp_to">' +
      '<input id="rp_targetlow"><input id="rp_targethigh">' +
      '<input id="rp_linear" type="radio"><input id="wrp_linear" type="radio">' +
      '<div id="info"></div><div class="rp_foodgui"></div>' +
      '</body></html>'
    );
    state = domGlobals.installDomGlobals(env);
    $ = env.window.$;
    env.window.moment = moment;
  });

  afterEach(function () {
    Object.keys(require.cache).forEach(function clearReportModules (modulePath) {
      if (modulePath.includes('/lib/report/') || modulePath.includes('/lib/report_plugins/')) {
        delete require.cache[modulePath];
      }
    });
    domGlobals.restoreDomGlobals(state);
  });

  it('builds and wires the report GUI only for the first authorized connection', function () {
    var authorizedCallback;
    var addHtmlCalls = 0;
    var reportPlugins = {
      addHtmlFromPlugins: function () { addHtmlCalls++; }
      , consts: {
        SCALE_LINEAR: 0
        , SCALE_LOG: 1
        , ORDER_OLDESTONTOP: 0
        , ORDER_NEWESTONTOP: 1
        , scaleYFromSettings: function () { return 0; }
      }
    };
    var client = {
      careportal: {events: []}
      , ctx: {moment: moment}
      , headers: function () { return {}; }
      , init: function (callback) { authorizedCallback = callback; }
      , settings: {
        scaleY: 'linear'
        , thresholds: {bgTargetBottom: 80, bgTargetTop: 180}
        , units: 'mg/dl'
      }
      , translate: function (value) { return value; }
      , utils: {scaleMgdl: function (value) { return value / 18; }}
    };

    $.ajax = function emptyFoodResponse (url, options) {
      options.success([]);
      var response = {
        done: function (callback) { callback(); return response; }
        , fail: function () { return response; }
      };
      return response;
    };
    env.window.Nightscout = {
      client: client
      , report_plugins_preinit: function () { return reportPlugins; }
    };

    require('../lib/report/reportclient')();
    authorizedCallback();

    addHtmlCalls.should.equal(1);
    $._data($('#rp_show')[0], 'events').click.length.should.equal(1);

    $('#rp_from').val('2025-02-03');
    $('#first').removeClass('selected');
    $('#second').addClass('selected');

    authorizedCallback();

    addHtmlCalls.should.equal(1);
    $('#rp_from').val().should.equal('2025-02-03');
    $('#tabnav > li.selected').attr('id').should.equal('second');
    $._data($('#rp_show')[0], 'events').click.length.should.equal(1);
  });

  it('makes plugin HTML and styles idempotent while preserving tab selection', function () {
    var client = {translate: function (value) { return value; }};
    env.window.Nightscout = {client: client};
    var plugins = require('../lib/report_plugins')({
      language: {translate: client.translate}
    });

    plugins.addHtmlFromPlugins(client);

    var menuCount = $('#tabnav > li').length;
    var placeholderCount = $('#pluginchartplaceholders > div').length;
    var styleCount = $('style[id$="-css"]').length;
    styleCount.should.be.above(0);

    var secondTab = $('#tabnav > li').eq(1);
    var secondPlaceholder = $('#pluginchartplaceholders > div').eq(1);
    $('#tabnav > li').removeClass('selected');
    secondTab.addClass('selected');
    $('#pluginchartplaceholders > div').hide();
    secondPlaceholder.show();

    plugins.addHtmlFromPlugins(client);

    $('#tabnav > li').length.should.equal(menuCount);
    $('#pluginchartplaceholders > div').length.should.equal(placeholderCount);
    $('style[id$="-css"]').length.should.equal(styleCount);
    new Set($('style[id$="-css"]').map(function () { return this.id; }).get()).size.should.equal(styleCount);
    $('#tabnav > li.selected').attr('id').should.equal(secondTab.attr('id'));
    secondPlaceholder.css('display').should.not.equal('none');
  });
});
