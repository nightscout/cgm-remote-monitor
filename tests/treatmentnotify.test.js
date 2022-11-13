var _ = require('lodash');
var should = require('should');
var levels = require('../lib/levels');

describe('treatmentnotify', function ( ) {

  var env = require('../lib/server/env')();
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);
  ctx.levels = levels;
  ctx.language = require('../lib/language')().set('en');

  var treatmentnotify = require('../lib/plugins/treatmentnotify')(ctx);

  var now = Date.now();

  it('Request a snooze for a recent treatment and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 100}];
    ctx.ddata.treatments = [{eventType: 'BG Check', glucose: '100', mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    _.first(ctx.notifications.findUnSnoozeable()).level.should.equal(levels.INFO);

    done();
  });

  it('Not Request a snooze for an older treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 100}];
    ctx.ddata.treatments = [{mills: now - (15 * 60 * 1000)}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findUnSnoozeable()));

    done();
  });

  it('Request a snooze for a recent calibration and request an info notify', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 100}];
    ctx.ddata.mbgs = [{mgdl: '100', mills: now}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    _.first(ctx.notifications.findUnSnoozeable()).level.should.equal(levels.INFO);

    done();
  });

  it('Not Request a snooze for an older calibration treatment and not request an info notification', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: now, mgdl: 100}];
    ctx.ddata.mbgs = [{mgdl: '100', mills: now - (15 * 60 * 1000)}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    treatmentnotify.checkNotifications(sbx);
    should.not.exist(ctx.notifications.findHighestAlarm());
    should.exist(ctx.notifications.snoozedBy({level: levels.URGENT}));

    should.not.exist(_.first(ctx.notifications.findUnSnoozeable()));

    done();
  });

  it('Request a notification for an announcement even there is an active snooze', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.treatments = [{mills: now, mgdl: 40, eventType: 'Announcement', isAnnouncement: true, notes: 'This not an alarm'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);

    var fakeSnooze = {
      level: levels.URGENT
      , title: 'Snoozing alarms for the test'
      , message: 'testing...'
      , lengthMills: 60000
    };

    sbx.notifications.requestSnooze(fakeSnooze);

    treatmentnotify.checkNotifications(sbx);

    var announcement = _.first(ctx.notifications.findUnSnoozeable());

    should.exist(announcement);
    announcement.title.should.equal('Urgent Announcement');
    announcement.level.should.equal(levels.URGENT);
    announcement.pushoverSound.should.equal('persistent');
    should.deepEqual(ctx.notifications.findHighestAlarm('Announcement'), announcement);
    ctx.notifications.snoozedBy(announcement).should.equal(false);


    done();
  });

  it('Request a notification for a non-error announcement', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.treatments = [{mills: now, mgdl: 100, eventType: 'Announcement', isAnnouncement: true, notes: 'This not an alarm'}];

    var sbx = require('../lib/sandbox')().serverInit(env, ctx);

    treatmentnotify.checkNotifications(sbx);

    var announcement = _.first(ctx.notifications.findUnSnoozeable());

    should.exist(announcement);
    announcement.title.should.equal('Announcement');
    announcement.level.should.equal(levels.INFO);
    should.not.exist(announcement.pushoverSound);
    should.not.exist(ctx.notifications.findHighestAlarm());
    ctx.notifications.snoozedBy(announcement).should.equal(false);

    done();
  });

});