'use strict';

const fs = require('fs');
const language = require('../lib/language')(fs);
require('should');

describe('Database Size', function() {

  var dataInRange = { dbstats: { dataSize: 1024 * 1024 * 137, indexSize: 1024 * 1024 * 48, fileSize: 1024 * 1024 * 256 } };
  var dataWarn = { dbstats: { dataSize: 1024 * 1024 * 250, indexSize: 1024 * 1024 * 100, fileSize: 1024 * 1024 * 360 } };
  var dataUrgent = { dbstats: { dataSize: 1024 * 1024 * 300, indexSize: 1024 * 1024 * 150, fileSize: 1024 * 1024 * 496 } };

  var env = require('../env')();

  it('display database size in range', function(done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: language
    };
    ctx.levels = require('../lib/levels');

    var sbx = sandbox.clientInit(ctx, Date.now(), dataInRange);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('dbsize');
      var result = setter();
      result.display.should.equal('37%');
      result.status.should.equal('current');
      done();
    };

    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx);

  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('display database size warning', function(done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: language
    };
    ctx.levels = require('../lib/levels');

    var sbx = sandbox.clientInit(ctx, Date.now(), dataWarn);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('dbsize');
      var result = setter();
      result.display.should.equal('70%');
      result.status.should.equal('warn');
      done();
    };

    var dbsize = require('../lib/plugins/dbsize')(ctx);

    dbsize.setProperties(sbx);

  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('display database size urgent', function(done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: language
    };
    ctx.levels = require('../lib/levels');

    var sbx = sandbox.clientInit(ctx, Date.now(), dataUrgent);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('dbsize');
      var result = setter();
      result.display.should.equal('90%');
      result.status.should.equal('urgent');
      done();
    };

    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx);

  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('display database size warning notiffication', function(done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: language
      , notifications: require('../lib/notifications')(env, ctx)
    };
    ctx.notifications.initRequests();
    ctx.levels = require('../lib/levels');

    var sbx = sandbox.clientInit(ctx, Date.now(), dataWarn);
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };

    var dbsize = require('../lib/plugins/dbsize')(ctx);

    dbsize.setProperties(sbx);
    dbsize.checkNotifications(sbx);

    var notif = ctx.notifications.findHighestAlarm('Database Size');
    notif.level.should.equal(ctx.levels.WARN);
    notif.title.should.equal('Warning Database Size near its limits!');
    notif.message.should.equal('Database size is 350 MiB out of 496 MiB. Please backup and clean up database!');
    done();
  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('display database size urgent notiffication', function(done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: language
      , notifications: require('../lib/notifications')(env, ctx)
    };
    ctx.notifications.initRequests();
    ctx.levels = require('../lib/levels');

    var sbx = sandbox.clientInit(ctx, Date.now(), dataUrgent);
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };

    var dbsize = require('../lib/plugins/dbsize')(ctx);

    dbsize.setProperties(sbx);
    dbsize.checkNotifications(sbx);

    var notif = ctx.notifications.findHighestAlarm('Database Size');
    notif.level.should.equal(ctx.levels.URGENT);
    notif.title.should.equal('Urgent Database Size near its limits!');
    notif.message.should.equal('Database size is 450 MiB out of 496 MiB. Please backup and clean up database!');
    done();
  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('set a pill to the database size in percent', function(done) {
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.value.should.equal('90%');
          options.labelClass.should.equal('plugicon-database');
          options.pillClass.should.equal('urgent');
          done();
        }
      }
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), dataUrgent);
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx);
    dbsize.updateVisualisation(sbx);

  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('set a pill to the database size in MiB', function(done) {
    var ctx = {
      settings: {
        extendedSettings: {
          empty: false
          , dbsize: {
            inMib: true
          }
        }
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.value.should.equal('450MiB');
          options.labelClass.should.equal('plugicon-database');
          options.pillClass.should.equal('urgent');
          done();
        }
      }
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), dataUrgent);
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx.withExtendedSettings(dbsize));
    dbsize.updateVisualisation(sbx);

  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('configure warn level percentage', function(done) {

    var ctx = {
      settings: {
        extendedSettings: {
          empty: false
          , dbsize: {
            warnPercentage: 30
          }
        }
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.value.should.equal('37%');
          options.pillClass.should.equal('warn');
          done();
        }
      }
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), dataInRange);
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx.withExtendedSettings(dbsize));
    dbsize.updateVisualisation(sbx);
  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('configure urgent level percentage', function(done) {

    var ctx = {
      settings: {
        extendedSettings: {
          empty: false
          , dbsize: {
            warnPercentage: 30
            , urgentPercentage: 36
          }
        }
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.value.should.equal('37%');
          options.pillClass.should.equal('urgent');
          done();
        }
      }
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), dataInRange);
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx.withExtendedSettings(dbsize));
    dbsize.updateVisualisation(sbx);
  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('hide the pill if there is no info regarding database size', function(done) {
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.hide.should.equal(true);
          done();
        }
      }
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), {});
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx);
    dbsize.updateVisualisation(sbx);
  });

  // ~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.~.

  it('should handle virtAsst requests', function(done) {

    var ctx = {
      settings: {}
      , language: language
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), dataUrgent);
    var dbsize = require('../lib/plugins/dbsize')(ctx);
    dbsize.setProperties(sbx);

    dbsize.virtAsst.intentHandlers.length.should.equal(1);

    dbsize.virtAsst.intentHandlers[0].intentHandler(function next (title, response) {
      title.should.equal('Database file size');
      response.should.equal('450 MiB. That is 90% of available database space.');

      done();

    }, [], sbx);

  });

});
