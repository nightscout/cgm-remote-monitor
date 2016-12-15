'use strict';

require('should');

describe('Uploader Battery', function ( ) {
  var data = {devicestatus: [{mills: Date.now(), uploader: {battery: 20}}]};

  it('display uploader battery status', function (done) {
    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {}
    };
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

    var upbat = require('../lib/plugins/upbat')();
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
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var upbat = require('../lib/plugins/upbat')();
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
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), {});
    var upbat = require('../lib/plugins/upbat')();
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
      }
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), {devicestatus: [{uploader: {battery: -1}}]});
    var upbat = require('../lib/plugins/upbat')();
    upbat.setProperties(sbx);
    upbat.updateVisualisation(sbx);
  });

  it('should handle alexa requests', function (done) {

    var ctx = {
      settings: {}
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var upbat = require('../lib/plugins/upbat')();
    upbat.setProperties(sbx);

    upbat.alexa.intentHandlers.length.should.equal(1);

    upbat.alexa.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Uploader battery');
      response.should.equal('Your uploader battery is at 20%');

      done();
    }, [], sbx);

  });

  it('should handle Google Home requests', function (done) {

    var ctx = {
      settings: {}
    };

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var upbat = require('../lib/plugins/upbat')();
    upbat.setProperties(sbx);

    upbat.googleHome.intentHandlers.length.should.equal(1);

    var req = {
       "result": {
         "source": "agent",
         "resolvedQuery": "What\'s my uploader battery?",
         "action": "",
         "actionIncomplete": false,
         "contexts": [],
         "metadata": {
           "intentId": "87a05d96-586a-4538-91bc-589d3e467e28",
           "webhookUsed": "false",
           "webhookForSlotFillingUsed": "false",
           "intentName": "UploaderBattery"
         },
         "score": 1
       }
     };

    upbat.googleHome.intentHandlers[0].intentHandler(req.result, function next(response) {
      response.should.equal('Your uploader battery is at 20%');

      done();
    }, sbx);

  });

});
