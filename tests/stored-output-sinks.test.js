'use strict';

var moment = require('moment');
var should = require('should');
var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

describe('stored-data browser output encoding', function () {
  var env;
  var state;
  var $;
  var priorD3;

  beforeEach(function () {
    priorD3 = global.d3;
    global.d3 = require('./fixtures/d3');
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = domGlobals.installDomGlobals(env);
    $ = env.window.$;
    env.window.moment = moment;
  });

  afterEach(function () {
    [
      '../lib/client/adminnotifiesclient'
      , '../lib/client/boluscalc'
      , '../lib/client/careportal'
      , '../lib/client/renderer'
      , '../lib/report_plugins/daytoday'
      , '../lib/report_plugins/treatments'
    ].forEach(function (moduleName) {
      delete require.cache[require.resolve(moduleName)];
    });
    if (priorD3 === undefined) delete global.d3;
    else global.d3 = priorD3;
    domGlobals.restoreDomGlobals(state);
  });

  it('renders legacy treatment report fields as literal text', function () {
    var client = {
      careportal: {
        resolveEventName: function (value) { return value; }
      }
      , profilefunctions: {
        listBasalProfiles: function () { return []; }
      }
      , sbx: {
        data: {
          profile: {
            applyTimezone: function (value) { return moment(value); }
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
    plugin.report({
      '2025-01-01': {
        treatments: [{
          _id: 'legacy-treatment'
          , created_at: '2025-01-01T00:00:00.000Z'
          , eventType: '<img src=x onerror="window.injected=true">Event'
          , reason: '<script>window.injected=true</script>Reason'
          , glucose: 'Fish &amp; Chips'
          , glucoseType: '<svg onload="window.injected=true">Type</svg>'
          , carbs: '<img src=x onerror="window.injected=true">Carbs'
          , foodType: 'Food &amp; More'
          , protein: '<b>Protein</b>'
          , fat: '<i>Fat</i>'
          , percent: '<u>Percent</u>'
          , profile: 'A&amp;B'
          , enteredBy: '<em>Uploader</em>'
          , notes: '<script>window.injected=true</script>Notes'
        }, {
          _id: 'legacy-treatment-without-glucose-type'
          , created_at: '2025-01-01T00:01:00.000Z'
          , glucose: 100
        }]
      }
    }, ['2025-01-01'], {order: 'oldest', units: 'mg/dl'});

    var cells = $('#treatments-report tr.border_bottom td');
    cells.eq(2).text().should.containEql('<img src=x onerror="window.injected=true">Event');
    cells.eq(2).text().should.containEql('<script>window.injected=true</script>Reason');
    cells.eq(3).text().should.equal('Fish & Chips (<svg onload="window.injected=true">Type</svg>)');
    cells.eq(5).text().should.equal('<img src=x onerror="window.injected=true">Carbs Food & More');
    cells.eq(6).text().should.equal('<b>Protein</b>');
    cells.eq(7).text().should.equal('<i>Fat</i>');
    cells.eq(9).text().should.equal('<u>Percent</u>');
    cells.eq(11).text().should.equal('A&B');
    cells.eq(12).text().should.equal('<em>Uploader</em>');
    cells.eq(13).text().should.equal('<script>window.injected=true</script>Notes');
    $('#treatments-report tr.border_bottom').eq(1).find('td').eq(3).text().should.equal('100');
    $('#treatments-report').find('script, svg, [onerror], [onload], img[src="x"]').length.should.equal(0);
    should(env.window.injected).equal(undefined);
  });

  it('filters treatment report rows without retaining empty day headings', function () {
    function translate (value, options) {
      if (!options || !options.params) { return value; }
      return options.params.reduce(function replaceParam (text, param, index) {
        return text.replace('%' + (index + 1), param);
      }, value);
    }

    var client = {
      careportal: {
        resolveEventName: function (value) { return value; }
      }
      , profilefunctions: {
        listBasalProfiles: function () { return []; }
      }
      , sbx: {
        data: {
          profile: {
            applyTimezone: function (value) { return moment(value); }
          }
        }
      }
      , settings: {timeFormat: 24, units: 'mg/dl'}
      , translate: translate
      , utils: {}
    };
    var reportPlugins = {
      consts: {ORDER_NEWESTONTOP: 'newest'}
      , utils: {localeDate: function (value) { return value; }}
    };
    env.window.Nightscout = {client: client, report_plugins: reportPlugins};

    var plugin = require('../lib/report_plugins/treatments')();
    $('body').append(plugin.html(client));
    var data = {
      '2025-01-01': {
        treatments: [
          {_id: 'exercise-1', created_at: '2025-01-01T01:00:00.000Z', eventType: 'Exercise'}
          , {_id: 'exercise-2', created_at: '2025-01-01T02:00:00.000Z', eventType: 'Exercise'}
          , {_id: 'untyped', created_at: '2025-01-01T03:00:00.000Z'}
        ]
      }
      , '2025-01-02': {
        treatments: [
          {_id: 'note', created_at: '2025-01-02T01:00:00.000Z', eventType: 'Note &amp; More'}
        ]
      }
    };

    plugin.report(data, ['2025-01-01', '2025-01-02'], {order: 'oldest', units: 'mg/dl'});

    $('#treatments-report tr.border_bottom').length.should.equal(4);
    $('#treatments-report td[colspan="12"]').length.should.equal(2);
    $('#treatments-eventtype option').length.should.equal(4);
    $('#treatments-eventtype option').filter(function hasDecodedLabel () {
      return $(this).text() === 'Note & More (1)';
    }).length.should.equal(1);
    $('#treatments-report .recordcount').text().should.equal('Showing 4 of 4 records');

    $('#treatments-eventtype').val('Exercise').trigger('change');
    $('#treatments-report tr.border_bottom').length.should.equal(2);
    $('#treatments-report td[colspan="12"]').length.should.equal(1);
    $('#treatments-report td[colspan="12"]').text().should.equal('2025-01-01');
    $('#treatments-report .recordcount').text().should.equal('Showing 2 of 4 records');

    var noneValue = $('#treatments-eventtype option').filter(function hasNoType () {
      return $(this).text() === '(none) (1)';
    }).val();
    $('#treatments-eventtype').val(noneValue).trigger('change');
    $('#treatments-report tr.border_bottom').length.should.equal(1);
    $('#treatments-report td[colspan="12"]').text().should.equal('2025-01-01');

    $('#treatments-eventtype').val('Exercise').trigger('change');
    plugin.report({'2025-01-02': data['2025-01-02']}, ['2025-01-02'], {order: 'oldest', units: 'mg/dl'});
    $('#treatments-eventtype').val().should.equal('\u0000all');
    $('#treatments-report tr.border_bottom').length.should.equal(1);
    $('#treatments-report .recordcount').text().should.equal('Showing 1 of 1 records');
  });

  it('renders admin notification fields as literal text', function () {
    $('body').append('<button id="adminnotifies"></button><div id="adminNotifiesDrawer"></div>');
    env.window.setTimeout = function () {};

    var notification = {
      title: '<img src=x onerror="window.injected=true">Title'
      , message: 'Fish &amp; Chips <script>window.injected=true</script>Message'
      , count: 1
      , lastRecorded: Date.now()
      , persistent: true
    };
    $.ajax = function () {
      return {
        done: function (callback) {
          callback({message: {notifies: [notification], notifyCount: 1}});
          return this;
        }
        , fail: function () { return this; }
      };
    };
    var client = {
      headers: function () { return {}; }
      , translate: function (value) { return value; }
    };

    var notifies = require('../lib/client/adminnotifiesclient')(client, $);
    notifies.prepare();

    $('#adminNotifiesDrawer b').last().text().should.equal('<img src=x onerror="window.injected=true">Title');
    $('#adminNotifiesDrawer .adminNotifyMessage').text()
      .should.equal('Fish & Chips <script>window.injected=true</script>Message');
    $('#adminNotifiesDrawer').find('img, script, svg, [onerror], [onload]').length.should.equal(0);
    should(env.window.injected).equal(undefined);
  });

  it('encodes legacy treatment glucose in the chart tooltip', function () {
    var d3 = require('./fixtures/d3');
    var root = d3.select(env.document.body).append('div');
    var tooltip = root.append('div').append('div').attr('id', 'tooltip');
    var chartSvg = d3.select(env.document.body).append('svg');
    var chart = {
      basals: chartSvg.append('g')
      , drag: chartSvg.append('g')
      , focus: chartSvg.append('g')
      , prevChartWidth: 900
      , xScale: function () { return 0; }
      , yScale: function () { return 0; }
    };
    var client = {
      careportal: {resolveEventName: function (value) { return value; }}
      , chart: chart
      , ddata: {profile: {getUnits: function () { return 'mg/dl'; }}}
      , editMode: false
      , focusRangeMS: 1
      , formatTime: function () { return '12:00'; }
      , sbx: {scaleEntry: function () { return 100; }}
      , settings: {units: 'mg/dl'}
      , tooltip: tooltip
      , translate: function (value) { return value; }
      , utils: {
        scaleMgdl: function (value) { return value; }
        , toRoundedStr: function (value) { return String(value); }
      }
    };
    var glucose = '<img src=x onerror="window.injected=true">Fish &amp; Chips';

    require('../lib/client/renderer')(client, d3).drawTreatment({
      carbs: 10
      , eventType: 'Meal Bolus'
      , glucose: glucose
      , mills: Date.now()
    }, {scale: 2, showLabels: false, treatments: 1}, 10, {});

    chart.focus.select('.draggable-treatment').node().dispatchEvent(
      new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 10, clientY: 10})
    );

    tooltip.text().should.containEql('<img src=x onerror="window.injected=true">Fish & Chips');
    tooltip.selectAll('img, script, svg, [onerror], [onload]').size().should.equal(0);
    should(env.window.injected).equal(undefined);
  });

  it('renders stored annotations as literal text in chart tooltips', function () {
    var d3 = require('./fixtures/d3');
    var tooltip = d3.select(env.document.body).append('div').append('div').attr('id', 'tooltip');
    var chartSvg = d3.select(env.document.body).append('svg');
    var treatment = {
      _id: 'legacy-tooltip-record'
      , eventType: 'Note'
      , enteredBy: '<svg onload="window.injected=true">Uploader</svg>'
      , mills: Date.now()
      , notes: '<img src=x onerror="window.injected=true">&amp;Notes'
    };
    var client = {
      careportal: {resolveEventName: function (value) { return value; }}
      , chart: {
        focus: chartSvg.append('g')
        , prevChartWidth: 900
        , xScale: function () { return 0; }
        , yScale: function () { return 0; }
      }
      , ddata: {
        tempTargetTreatments: []
        , treatments: [treatment]
      }
      , focusRangeMS: 1
      , formatTime: function () { return '12:00'; }
      , sbx: {scaleEntry: function () { return 100; }}
      , settings: {units: 'mg/dl'}
      , tooltip: tooltip
      , translate: function (value) { return value; }
      , utils: {}
    };

    require('../lib/client/renderer')(client, d3).addTreatmentCircles(new Date());
    chartSvg.select('.treatment-dot').node().dispatchEvent(
      new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 10, clientY: 10})
    );

    tooltip.text().should.containEql('<svg onload="window.injected=true">Uploader</svg>');
    tooltip.text().should.containEql('<img src=x onerror="window.injected=true">&Notes');
    tooltip.selectAll('img, script, svg, [onerror], [onload]').size().should.equal(0);
    should(env.window.injected).equal(undefined);
  });

  it('renders stored annotations as literal SVG text in the day-to-day report', function () {
    $('body').append('<div id="daytodaycharts"></div>');
    var d3 = require('./fixtures/d3');
    var day = '2025-01-01';
    var firstTime = Date.parse(day + 'T00:00:00.000Z');
    var rawPayload = '<img src=x onerror="window.injected=true">Notes';
    var encodedPayload = '&lt;img src=x onerror="window.injected=true"&gt;Notes';
    var profile = {
      applyTimezone: function (value) { return moment.utc(value); }
      , loadData: function () {}
      , parseInTimezone: function (value) { return moment.utc(value); }
      , updateTreatments: function () {}
    };
    var client = {
      plugins: function () {
        return {isDeviceStatusAvailable: function () { return false; }};
      }
      , profilefunctions: {activeProfileToTime: function () { return ''; }}
      , sbx: {data: {profile: profile}}
      , settings: {timeFormat: 24}
      , ticks: function () { return []; }
      , tooltip: d3.select(env.document.body).append('div')
      , translate: function (value) { return value; }
      , utils: {scaleMgdl: function (value) { return value; }, roundBGForDisplay: function (value) { return value; }}
    };
    var reportPlugins = {
      consts: {SCALE_LOG: 'log'}
      , utils: {
        localeDate: function (value) { return value; }
        , scaledTreatmentBG: function () { return 100; }
      }
    };
    var dayData = {
      dailyCarbs: 0
      , dailyFat: 0
      , dailyProtein: 0
      , devicestatus: []
      , sgv: [
        {color: 'green', date: new Date(firstTime), mills: firstTime, sgv: 100, type: 'sgv', openaps: {suggested: {bg: 100, reason: rawPayload}}}
        , {color: 'green', date: new Date(firstTime + 60000), mills: firstTime + 60000, sgv: 110, type: 'sgv'}
      ]
      , treatments: [
        {_id: 'raw', eventType: 'Note', mills: firstTime + 10000, notes: rawPayload}
        , {_id: 'encoded', eventType: 'Note', mills: firstTime + 20000, notes: encodedPayload}
        , {_id: 'food', eventType: 'Meal Bolus', mills: firstTime + 30000, carbs: 10, foodType: 'Fish &amp; Chips'}
      ]
    };
    var data = {
      alldays: 1
      , combobolusTreatments: []
      , devicestatus: []
      , profiles: []
      , profileSwitchTreatments: []
      , tempbasalTreatments: []
      , treatments: []
    };
    data[day] = dayData;
    env.window.Nightscout = {
      client: client
      , predictions: {offset: 0}
      , report_plugins: reportPlugins
    };

    require('../lib/report_plugins/daytoday')().report(data, [day], {
      basal: false
      , bgcheck: false
      , carbs: true
      , cob: false
      , food: false
      , height: 250
      , insulin: false
      , insulindistribution: false
      , iob: false
      , maxCarbsValue: 20
      , maxDailyCarbsValue: 1
      , maxInsulinValue: 1
      , notes: true
      , openAps: true
      , othertreatments: false
      , predicted: false
      , raw: false
      , scale: 'linear'
      , targetHigh: 180
      , targetLow: 80
      , width: 800
    });

    var forecastDot = env.document.querySelector('#daytodaycharts circle');
    forecastDot.dispatchEvent(new env.window.MouseEvent('mouseover', {bubbles: true, clientX: 120, clientY: 80}));
    client.tooltip.text().should.containEql(rawPayload);
    client.tooltip.style('left').should.equal('120px');
    client.tooltip.style('top').should.equal('95px');
    client.tooltip.selectAll('img, script').size().should.equal(0);
    forecastDot.dispatchEvent(new env.window.MouseEvent('mouseout', {bubbles: true}));
    client.tooltip.style('display').should.equal('none');

    var noteTexts = Array.from(env.document.querySelectorAll('#daytodaycharts svg text'))
      .map(function (node) { return node.textContent; });
    noteTexts.should.containEql(rawPayload);
    noteTexts.filter(function (value) { return value === rawPayload; }).length.should.equal(2);
    noteTexts.should.containEql(' 10 g Fish & Chips');
    $('#daytodaycharts').find('img, script, svg svg, [onerror], [onload]').length.should.equal(0);
    should(env.window.injected).equal(undefined);
  });

  it('builds food quick-pick options without parsing their labels', function () {
    $('body').append(
      '<select id="bc_quickpick"></select>' +
      '<select id="bc_filter_category"></select>' +
      '<select id="bc_filter_subcategory"></select>' +
      '<select id="bc_data"></select>' +
      '<input id="bc_filter_name"><input id="bc_addportions">'
    );
    var originalArrayMap = Array.prototype.map;
    var client = {
      ctx: {moment: moment}
      , plugins: function () { return {}; }
      , sbx: {
        data: {
          food: [{
            type: 'quickpick'
            , name: '<img src=x onerror="window.injected=true">Fish &amp; Chips'
            , carbs: 10
          }, {
            type: 'food'
            , category: '__proto__'
            , subcategory: 'map'
            , name: 'Prototype test'
            , portion: 1
            , unit: 'g'
            , carbs: 1
          }]
        }
      }
      , translate: function (value) { return value; }
    };

    try {
      var boluscalc = require('../lib/client/boluscalc')(client, $);
      boluscalc.loadFoodQuickpicks();
      boluscalc.loadFoodDatabase();

      $('#bc_quickpick option').eq(1).text()
        .should.equal('<img src=x onerror="window.injected=true">Fish & Chips (10 g)');
      $('#bc_filter_category option').eq(1).val().should.equal('__proto__');
      Array.prototype.map.should.equal(originalArrayMap);
      $('#bc_quickpick').find('img, script, [onerror]').length.should.equal(0);
      should(env.window.injected).equal(undefined);
    } finally {
      Array.prototype.map = originalArrayMap;
    }
  });

  it('builds profile-derived Care Portal reason options without parsing them', function () {
    $('body').append('<select id="eventType"></select><select id="reason"></select>');
    var payload = 'x"></option></select><img src=x onerror="window.injected=true"><select><option value="x';
    var client = {
      plugins: {
        getAllEventTypes: function () {
          return [{
            val: 'Temporary Override'
            , name: 'Temporary Override'
            , reasons: [{name: payload, displayName: payload}]
          }];
        }
      }
      , sbx: {}
      , settings: {units: 'mg/dl'}
      , translate: function (value) { return value; }
    };

    var careportal = require('../lib/client/careportal')(client, $);
    careportal.prepareEvents();

    $('#reason option').length.should.equal(1);
    $('#reason option').val().should.equal(payload);
    $('#reason option').text().should.equal(payload);
    $('body').find('img, script, svg, [onerror], [onload]').length.should.equal(0);
    should(env.window.injected).equal(undefined);
  });
});
