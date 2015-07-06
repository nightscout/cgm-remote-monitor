var _ = require('lodash');
var should = require('should');

describe('treatmentnotify', function ( ) {

  var treatmentnotify = require('../lib/plugins/treatmentnotify')();

  var env = require('../env')();
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  it('Request a snooze for a recent treatment and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 100}];
    ctx.data.treatments = [{eventType: 'BG Check', glucose: '100', created_at: (new Date()).toISOString()}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: ctx.notifications.levels.URGENT}));

    _.first(ctx.notifications.findInfos()).level.should.equal(ctx.notifications.levels.INFO);

    done();
  });

  it('Not Request a snooze for an older treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 100}];
    ctx.data.treatments = [{created_at: (new Date(Date.now() - (15 * 60 * 1000))).toISOString()}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: ctx.notifications.levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findInfos()));

    done();
  });

  it('Request a snooze for a recent calibration and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 100}];
    ctx.data.mbgs = [{y: '100', x: Date.now()}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: ctx.notifications.levels.URGENT}));

    _.first(ctx.notifications.findInfos()).level.should.equal(ctx.notifications.levels.INFO);

    done();
  });

  it('Not Request a snooze for an older calibration treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{sgv: 100}];
    ctx.data.mbgs = [{y: '100', x: Date.now() - (15 * 60 * 1000)}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: ctx.notifications.levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findInfos()));

    done();
  });


});