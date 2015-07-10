'use strict';

require('should');

describe('cage', function ( ) {
  var cage = require('../lib/plugins/cannulaage')();
  var sandbox = require('../lib/sandbox')();
  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    sbx.offerProperty('iob', function () {
      return {iob: 0};
    });
    return sbx;
  }

  it('set a pill to the current cannula age', function (done) {

    var app = {};
    var clientSettings = {};

    var data = {
      treatments: [{eventType: 'Site Change', mills: Date.now() - 24 * 60 * 60000}]
    };

    var pluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.value.should.equal('24h');
        done();
      }
    };

    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);
    cage.updateVisualisation(sbx);

  });

  
 it('trigger a warning when cannula is 48 hours old', function (done) {
    ctx.notifications.initRequests();

    var before = Date.now() - (48 * 60 * 60 * 1000);

    ctx.data.treatments = [{eventType: 'Site Change', mills: before}];

    var sbx = prepareSandbox();
    sbx.extendedSettings = { 'enablealerts': 'TRUE' };
    cage.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(ctx.notifications.levels.WARN);
    highest.title.should.equal('Cannula age 48 hours');
    done();
  });

});
