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

  function renderReport (records) {
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
