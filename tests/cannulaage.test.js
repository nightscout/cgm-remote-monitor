'use strict';

require('should');
var levels = require('../lib/levels');

describe('cage', function ( ) {
  var env = require('../lib/server/env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  ctx.language = require('../lib/language')();
  ctx.levels = levels;

  var cage = require('../lib/plugins/cannulaage')(ctx);
  var sandbox = require('../lib/sandbox')(ctx);
  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });
    return sbx;
  }

  it('set a pill to the current cannula age', function (done) {

    var data = {
      sitechangeTreatments: [
        {eventType: 'Site Change', notes: 'Foo', mills: Date.now() - 48 * 60 * 60000}
        , {eventType: 'Site Change', notes: 'Bar', mills: Date.now() - 24 * 60 * 60000}
        ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('24h');
          options.info[1].value.should.equal('Bar');
          done();
        }
      }
    };

    ctx.language = require('../lib/language')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    cage.setProperties(sbx);
    cage.updateVisualisation(sbx);

  });

  it('set a pill to the current cannula age', function (done) {

    var data = {
      sitechangeTreatments: [
        {eventType: 'Site Change', notes: 'Foo', mills: Date.now() - 48 * 60 * 60000}
        , {eventType: 'Site Change', notes: '', mills: Date.now() - 59 * 60000}
        ]
    };

    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('0h');
          options.info.length.should.equal(1);
          done();
        }
      }
    };
    ctx.language = require('../lib/language')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    cage.setProperties(sbx);
    cage.updateVisualisation(sbx);

  });

  
 it('trigger a warning when cannula is 48 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - (48 * 60 * 60 * 1000);

    ctx.ddata.sitechangeTreatments = [{eventType: 'Site Change', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    cage.setProperties(sbx);
    cage.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('CAGE');
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Cannula age 48 hours');
    done();
  });

});
