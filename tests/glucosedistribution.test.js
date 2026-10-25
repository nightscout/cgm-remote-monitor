'use strict';

var moment = require('moment');
var should = require('should');
var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

describe('glucosedistribution report', function distributionReportTests () {
  var env;
  var state;
  var $;

  beforeEach(function installReportDOM () {
    delete global.window;
    delete global.document;
    env = createSecureDOM('<!DOCTYPE html><html><body></body></html>');
    state = domGlobals.installDomGlobals(env);
    $ = env.window.$;
    env.window.moment = moment;
  });

  afterEach(function cleanupReportDOM (done) {
    // the plugin defers its pie chart via setTimeout; let that timer fire
    // while the DOM globals are still installed, then clean up
    setTimeout(function restoreReportDOM () {
      delete require.cache[require.resolve('../lib/report_plugins/glucosedistribution')];
      domGlobals.restoreDomGlobals(state);
      done();
    }, 10);
  });

  function renderReport (records, selectedHours) {
    var client = {
      sbx: {
        data: {
          profile: {
            applyTimezone: function applyTimezone (value) { return moment(value); }
          }
        }
      }
      , settings: {units: 'mg/dl'}
      , translate: function translate (value) { return value; }
    };
    env.window.Nightscout = {
      client: client
      , report_plugins: {
        utils: {localeDate: function localeDate (value) { return value; }}
      }
    };

    var plugin = require('../lib/report_plugins/glucosedistribution')();
    $('body').append(plugin.html(client));
    if (selectedHours) {
      for (var hour = 0; hour < 24; hour++) {
        $('#glucosedistribution-' + hour).prop('checked', selectedHours.includes(hour));
      }
    }
    $.plot = function plot () {};
    plugin.report({allstatsrecords: records, alldays: 1}, ['2025-01-01'], {
      targetLow: 80
      , targetHigh: 180
    });
  }

  function overallReadings () {
    return parseInt($('#glucosedistribution-report table tr:last td').eq(2).text(), 10);
  }

  function inRangeReadings () {
    return parseInt($('#glucosedistribution-report table tr').eq(2).find('td').eq(2).text(), 10);
  }

  function reading (minute, value) {
    return {
      sgv: value
      , bgValue: value
      , displayTime: new Date(Date.parse('2025-01-01T00:00:00.000Z') + minute * 60 * 1000)
    };
  }

  [
    { first: 54, rangeRow: 1, average: '99.8', name: 'low' }
    , { first: 250, rangeRow: 3, average: '100.5', name: 'high' }
  ].forEach(function (example) {
    it('does not give the first ' + example.name + ' reading extra weight in a full day', function () {
      var records = [];
      for (var i = 0; i < 288; i++) {
        records.push(reading(i * 5, i === 0 ? example.first : 100));
      }

      renderReport(records);

      overallReadings().should.equal(288);
      inRangeReadings().should.equal(287);
      var rangeCells = $('#glucosedistribution-report table tr').eq(example.rangeRow).find('td');
      rangeCells.eq(1).text().should.equal('0.3%');
      rangeCells.eq(2).text().should.equal('1');
      $('#glucosedistribution-report table tr:last td').eq(3).text().should.equal(example.average);
    });
  });

  it('still includes an interpolated sample for a missing five-minute reading', function () {
    var records = [reading(0, 100), reading(5, 101), reading(15, 103), reading(20, 104)];

    renderReport(records);

    // Four measurements plus the existing interpolation at minute 10.
    records.length.should.equal(4);
    overallReadings().should.equal(5);
    inRangeReadings().should.equal(5);
    $('#glucosedistribution-report table tr:last td').eq(3).text().should.equal('102.0');
    $('#glucosedistribution-stability tr').eq(1).find('td').eq(0).text().should.equal('288 mg/dl');
    $('#glucosedistribution-stability tr').eq(3).find('td').eq(0).text().should.equal('12 mg/dl');
  });

  it('includes the first selected interval when earlier hours are excluded', function () {
    var records = [];
    for (var i = 0; i < 288; i++) {
      records.push(reading(i * 5, 100 + i));
    }

    renderReport(records, [1]);

    // 01:00 through 01:55 contains 12 readings and eleven five-minute intervals.
    overallReadings().should.equal(12);
    $('#glucosedistribution-report table tr:last td').eq(3).text().should.equal('117.5');
    $('#glucosedistribution-stability tr').eq(1).find('td').eq(0).text().should.equal('288 mg/dl');
    $('#glucosedistribution-stability tr').eq(3).find('td').eq(0).text().should.equal('12 mg/dl');
  });

  it('counts each statsrecord once when readings arrive every 5 minutes', function countRegularReadings () {
    var start = Date.parse('2025-01-01T00:00:00.000Z');
    var records = [];
    for (var i = 0; i < 12; i++) {
      records.push({
        sgv: 100 + i
        , bgValue: 100 + i
        , displayTime: new Date(start + i * 5 * 60 * 1000)
      });
    }

    renderReport(records);

    inRangeReadings().should.equal(records.length);
    overallReadings().should.equal(records.length);
    $('#glucosedistribution-stability tr').eq(1).find('td').eq(0).text().should.equal('288 mg/dl');
    $('#glucosedistribution-stability tr').eq(3).find('td').eq(0).text().should.equal('12 mg/dl');
  });

  it('counts a single statsrecord once', function countSingleReading () {
    var records = [{
      sgv: 100
      , bgValue: 100
      , displayTime: new Date(Date.parse('2025-01-01T00:00:00.000Z'))
    }];

    renderReport(records);

    overallReadings().should.equal(1);
  });
});
