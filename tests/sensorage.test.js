'use strict';

var should = require('should');
var times = require('../lib/times');
const helper = require('./inithelper')();

describe('sage', function ( ) {
  var env = require('../lib/server/env')();
  var ctx = helper.getctx();
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  var sage = require('../lib/plugins/sensorage')(ctx);
  var sandbox = require('../lib/sandbox')();

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    return sbx;
  }

  describe('several Sensor Starts within one hour (BF-207)', function () {
    var HOUR = times.hours(1).msecs;

    function latest (now, events) {
      var sbx = prepareSandbox();
      sbx.time = now;
      sbx.data.sensorTreatments = events.map(function (event) {
        return { eventType: 'Sensor Start', mills: now - event[0], notes: event[1] };
      });
      return sage.findLatestTimeChange(sbx)['Sensor Start'];
    }

    it('keeps the newest of them, oldest first', function () {
      var now = Date.now();
      var found = latest(now, [[3 * HOUR + 10000, 'older'], [3 * HOUR + 1000, 'newer']]);
      found.notes.should.equal('newer');
      found.treatmentDate.should.equal(now - 3 * HOUR - 1000);
    });

    it('keeps the newest of them, newest first', function () {
      var now = Date.now();
      var found = latest(now, [[3 * HOUR + 1000, 'newer'], [3 * HOUR + 10000, 'older']]);
      found.notes.should.equal('newer');
    });

    it('keeps the newest across a whole-hour boundary', function () {
      var now = Date.now();
      var found = latest(now, [[3 * HOUR + 2000, 'older'], [3 * HOUR - 2000, 'newer']]);
      found.notes.should.equal('newer');
      found.age.should.equal(2);
    });
  });

  it('displays elapsed age correctly across the fall-back DST transition', function () {
    var now = Date.UTC(2026, 10, 1, 16);
    var result = sage.findLatestTimeChange({
      time: now,
      extendedSettings: {},
      data: { sensorTreatments: [{ eventType: 'Sensor Start', mills: now - times.days(1).msecs }] }
    });
    result['Sensor Start'].days.should.equal(1);
    result['Sensor Start'].hours.should.equal(0);
    result['Sensor Start'].display.should.equal('1d0h');
  });

  it('set a pill to the current age since start with change', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Change', notes: 'Foo', mills: Date.now() - times.days(2).msecs}
        , {eventType: 'Sensor Start', notes: 'Bar', mills: Date.now() - times.days(1).msecs}
        ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
        
          console.log(JSON.stringify(options));
          options.value.should.equal('1d0h');
          options.info[0].label.should.equal('Sensor Insert');
          options.info[1].should.match({ label: 'Duration', value: '2 days 0 hours' });
          options.info[2].should.match({ label: 'Notes', value: 'Foo' });
          options.info[3].label.should.equal('Sensor Start');
          options.info[4].should.match({ label: 'Duration', value: '1 days 0 hours' });
          options.info[5].should.match({ label: 'Notes', value: 'Bar' });
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

  it('set a pill to the current age since start without change', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Start', notes: 'Bar', mills: Date.now() - times.days(3).msecs}
      ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('3d0h');
          options.info[0].label.should.equal('Sensor Start');
          options.info[1].should.match({ label: 'Duration', value: '3 days 0 hours' });
          options.info[2].should.match({ label: 'Notes', value: 'Bar' });
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

  it('set a pill to the current age since change without start', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Change', notes: 'Foo', mills: Date.now() - times.days(3).msecs}
      ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('3d0h');
          options.info[0].label.should.equal('Sensor Insert');
          options.info[1].should.match({ label: 'Duration', value: '3 days 0 hours' });
          options.info[2].should.match({ label: 'Notes', value: 'Foo' });
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

  it('set a pill to the current age since change after start', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Start', notes: 'Bar', mills: Date.now() - times.days(10).msecs}
        , {eventType: 'Sensor Change', notes: 'Foo', mills: Date.now() - times.days(3).msecs}
      ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('3d0h');
          options.info.length.should.equal(3);
          options.info[0].label.should.equal('Sensor Insert');
          options.info[1].should.match({ label: 'Duration', value: '3 days 0 hours' });
          options.info[2].should.match({ label: 'Notes', value: 'Foo' });
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

  it('trigger an alarm when sensor is 6 days and 22 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - times.days(6).msecs - times.hours(22).msecs;

    ctx.ddata.sensorTreatments = [{eventType: 'Sensor Start', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enableAlerts': true };
    sage.setProperties(sbx);
    sage.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('SAGE');
    highest.level.should.equal(ctx.levels.URGENT);
    highest.title.should.equal('Sensor age 6 days 22 hours');
    done();
  });

  it('not trigger an alarm when sensor is 6 days and 23 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - times.days(6).msecs - times.hours(23).msecs;

    ctx.ddata.sensorTreatments = [{eventType: 'Sensor Start', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enableAlerts': true };
    sage.setProperties(sbx);
    sage.checkNotifications(sbx);

    should.not.exist(ctx.notifications.findHighestAlarm('SAGE'));
    done();
  });

  it('show n/a when no sensor treatment has been recorded', function (done) {

    var data = {
      sensorTreatments: [ ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('n/a ');
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

  it('show the age when a sensor treatment has been recorded', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Start', mills: Date.now() - times.days(3).msecs}
      ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('3d0h');
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.setProperties(sbx);
    sage.updateVisualisation(sbx);

  });

});
