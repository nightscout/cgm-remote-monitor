var _ = require('lodash');
var should = require('should');
var levels = require('../lib/levels');

describe('treatmentnotify', function ( ) {

  var treatmentnotify = require('../lib/plugins/treatmentnotify')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  var now = Date.now();

  it('Request a snooze for a recent treatment and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now, mgdl: 100}];
    ctx.data.treatments = [{eventType: 'BG Check', glucose: '100', mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    _.first(ctx.notifications.findInfos()).level.should.equal(levels.INFO);

    done();
  });

  it('Not Request a snooze for an older treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now, mgdl: 100}];
    ctx.data.treatments = [{mills: now - (15 * 60 * 1000)}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findInfos()));

    done();
  });

  it('Request a snooze for a recent calibration and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now, mgdl: 100}];
    ctx.data.mbgs = [{mgdl: '100', mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    _.first(ctx.notifications.findInfos()).level.should.equal(levels.INFO);

    done();
  });

  it('Not Request a snooze for an older calibration treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: now, mgdl: 100}];
    ctx.data.mbgs = [{mgdl: '100', mills: now - (15 * 60 * 1000)}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findInfos()));

    done();
  });


});