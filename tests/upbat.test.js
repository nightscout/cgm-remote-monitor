'use strict';

require('should');

describe('Uploader Battery', function ( ) {
  var data = {devicestatus: [{mills: Date.now(), uploader: {battery: 20}}]};

  it('display uploader battery status', function (done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
      , language: require('../lib/language')()
    };
    ctx.language.set('en');
    ctx.levels = require('../lib/levels');
    
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('upbat');
      var result = setter();
      result.display.should.equal('20%');
      result.status.should.equal('urgent');
      result.min.value.should.equal(20);
      result.min.level.should.equal(25);
      done();
    };

    var upbat = require('../lib/plugins/upbat')(ctx);
    upbat.setProperties(sbx);

  });

  it('set a pill to the uploader battery status', function (done) {
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.value.should.equal('20%');
          options.labelClass.should.equal('icon-battery-25');
          options.pillClass.should.equal('urgent');
          done();
        }
      }
      , language: require('../lib/language')()
    };
    ctx.language.set('en');

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var upbat = require('../lib/plugins/upbat')(ctx);
    upbat.setProperties(sbx);
    upbat.updateVisualisation(sbx);

  });

  it('hide the pill if there is no uploader battery status', function (done) {
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.hide.should.equal(true);
          done();
        }
      }
      , language: require('../lib/language')()
    };
    ctx.language.set('en');

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), {});
    var upbat = require('../lib/plugins/upbat')(ctx);
    upbat.setProperties(sbx);
    upbat.updateVisualisation(sbx);
  });

  it('hide the pill if there is uploader battery status is -1', function (done) {
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.hide.should.equal(true);
          done();
        }
      }, language: require('../lib/language')()
    };
    ctx.language.set('en');

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), {devicestatus: [{uploader: {battery: -1}}]});
    var upbat = require('../lib/plugins/upbat')(ctx);
    upbat.setProperties(sbx);
    upbat.updateVisualisation(sbx);
  });

  it('should handle alexa requests', function (done) {

    var ctx = {
      settings: {}
      , language: require('../lib/language')()
    };
    ctx.language.set('en');

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var upbat = require('../lib/plugins/upbat')(ctx);
    upbat.setProperties(sbx);

    upbat.alexa.intentHandlers.length.should.equal(1);

    upbat.alexa.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Uploader battery');
      response.should.equal('Your uploader battery is at 20%');

      done();
    }, [], sbx);

  });

});
