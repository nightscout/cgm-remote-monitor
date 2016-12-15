'use strict';

require('should');

describe('Raw BG', function ( ) {
  var rawbg = require('../lib/plugins/rawbg')({
    settings: {}
    , language: require('../lib/language')()
  });

  var now = Date.now();
  var data = {
    sgvs: [{unfiltered: 113680, filtered: 111232, mgdl: 110, noise: 1, mills: now}]
    , cals: [{scale: 1, intercept: 25717.82377004309, slope: 766.895601715918, mills: now}]
  };
  var ctx = {
    settings: {
      units: 'mg/dl'
    }
    , pluginBase: {}
  };

  it('should calculate Raw BG', function (done) {
    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('rawbg');
      var result = setter();
      result.mgdl.should.equal(113);
      result.noiseLabel.should.equal('Clean');
      done();
    };

    rawbg.setProperties(sbx);

  });

  it('should handle alexa requests', function (done) {

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    rawbg.setProperties(sbx);

    rawbg.alexa.intentHandlers.length.should.equal(1);

    rawbg.alexa.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Current Raw BG');
      response.should.equal('Your raw bg is 113');

      done();
    }, [], sbx);

  });

  it('should handle Google Home requests', function(done) {

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    rawbg.setProperties(sbx);

    rawbg.googleHome.intentHandlers.length.should.equal(1);

    var req = {
      "result": {
        "source": "agent",
        "resolvedQuery": "What\'s my raw blood glucose?",
        "action": "",
        "actionIncomplete": false,
        "parameters": {
          "metric": "raw blood glucose"
        },
        "contexts": [],
        "metadata": {
          "intentId": "c57a04a2-2f0c-4f86-b1cc-8af4c3314d6c",
          "webhookUsed": "false",
          "webhookForSlotFillingUsed": "false",
          "intentName": "CurrentMetric"
        }
      }
    }

    var intentHandler = rawbg.googleHome.intentHandlers[0];

    intentHandler.intent.should.equal('CurrentMetric');
    intentHandler.routableSlot.should.equal('metric');
    intentHandler.slots.length.should.equal(3);
    intentHandler.slots[0].should.equal('raw bg');
    intentHandler.slots[1].should.equal('raw blood glucose');
    intentHandler.slots[2].should.equal('raw blood sugar');

    intentHandler.intentHandler(req.result, function next(response) {
      response.should.equal('Your current raw blood glucose is 113');
    }, sbx);

    var reqGivenName = {
       "result": {
         "source": "agent",
         "resolvedQuery": "What\'s Rick\'s raw blood glucose?",
         "action": "",
         "actionIncomplete": false,
         "parameters": {
           "givenName": "Rick",
           "metric": "raw blood glucose"
         },
         "contexts": [],
         "metadata": {
           "intentId": "87a05d96-586a-4538-91bc-589d3e467e28",
           "webhookUsed": "false",
           "webhookForSlotFillingUsed": "false",
           "intentName": "CurrentMetric"
         }
       }
     };

    intentHandler.intentHandler(reqGivenName.result, function next(response) {
      response.should.equal('Rick\'s current raw blood glucose is 113');

      done();
    }, sbx);

  });

});
