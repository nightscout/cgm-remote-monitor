'use strict';

var should = require('should');
var times = require('../lib/times');
var levels = require('../lib/levels');

describe('sage', function ( ) {
  var sage = require('../lib/plugins/sensorage')();
  var sandbox = require('../lib/sandbox')();
  var env = require('../env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    return sbx;
  }

  it('set a pill to the current age since start with change', function (done) {

    var data = {
      sensorTreatments: [
        {eventType: 'Sensor Change', notes: 'Foo', mills: Date.now() - times.days(15).msecs}
        , {eventType: 'Sensor Start', notes: 'Bar', mills: Date.now() - times.days(3).msecs}
        ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('3d0h');
          options.info[0].label.should.equal('Sensor Insert');
          options.info[1].should.match({ label: 'Duration', value: '15 days 0 hours' });
          options.info[2].should.match({ label: 'Notes:', value: 'Foo' });
          options.info[3].label.should.equal('Sensor Start');
          options.info[4].should.match({ label: 'Duration', value: '3 days 0 hours' });
          options.info[5].should.match({ label: 'Notes:', value: 'Bar' });
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
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
          options.info[2].should.match({ label: 'Notes:', value: 'Bar' });
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
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
          options.info[2].should.match({ label: 'Notes:', value: 'Foo' });
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
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
          options.info[2].should.match({ label: 'Notes:', value: 'Foo' });
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    sage.updateVisualisation(sbx);

  });

  it('trigger an alarm when sensor is 6 days and 22 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - times.days(6).msecs - times.hours(22).msecs;

    ctx.ddata.sensorTreatments = [{eventType: 'Sensor Start', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enableAlerts': true };
    sage.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('SAGE');
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('Sensor age 6 days 22 hours');
    done();
  });

  it('not trigger an alarm when sensor is 6 days and 23 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - times.days(6).msecs - times.hours(23).msecs;

    ctx.ddata.sensorTreatments = [{eventType: 'Sensor Start', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enableAlerts': true };
    sage.checkNotifications(sbx);

    should.not.exist(ctx.notifications.findHighestAlarm('SAGE'));
    done();
  });

});
