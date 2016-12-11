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

    rawbg.googleHome.intentHandlers.length.should.equal(2);

    var req = {
      "id": "b6b30104-0629-408a-b781-9fc265ac1df1",
      "timestamp": "2016-12-11T18:44:51.422Z",
      "result": {
        "source": "agent",
        "resolvedQuery": "What\'s my raw blood glucose?",
        "action": "",
        "actionIncomplete": false,
        "parameters": {
          "readingType": "raw blood glucose"
        },
        "contexts": [],
        "metadata": {
          "intentId": "c57a04a2-2f0c-4f86-b1cc-8af4c3314d6c",
          "webhookUsed": "false",
          "webhookForSlotFillingUsed": "false",
          "intentName": "current_raw_bg"
        },
        "score": 1
      },
      "status": {
        "code": 200,
        "errorType": "success"
      },
      "sessionId": "4a7727af-90ce-4a1a-9732-0cc67c1dedf3"
    }

    rawbg.googleHome.intentHandlers[0].intentName.should.equal('current_raw_bg');
    rawbg.googleHome.intentHandlers[0].intentHandler(req.result, function next(response) {
      response.should.equal('Your current raw blood glucose is 113');
    }, sbx);

    var reqGivenName = {
       "id": "28987593-8afe-4dbc-89b6-863e3c2f2186",
       "timestamp": "2016-12-11T17:30:46.296Z",
       "result": {
         "source": "agent",
         "resolvedQuery": "What\'s Rick\'s raw blood glucose?",
         "action": "",
         "actionIncomplete": false,
         "parameters": {
           "givenName": "Rick",
           "readingType": "raw blood glucose"
         },
         "contexts": [],
         "metadata": {
           "intentId": "87a05d96-586a-4538-91bc-589d3e467e28",
           "webhookUsed": "false",
           "webhookForSlotFillingUsed": "false",
           "intentName": "current_bg_given_name"
         },
         "score": 1
       },
       "status": {
         "code": 200,
         "errorType": "success"
       },
       "sessionId": "4a7727af-90ce-4a1a-9732-0cc67c1dedf3"
     };

    rawbg.googleHome.intentHandlers[1].intentName.should.equal('current_raw_bg_given_name');
    rawbg.googleHome.intentHandlers[1].intentHandler(reqGivenName.result, function next(response) {
      response.should.equal('Rick\'s current raw blood glucose is 113');

      done();
    }, sbx);

  });

});
