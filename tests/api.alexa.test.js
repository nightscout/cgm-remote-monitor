'use strict';

var request = require('supertest');
var language = require('../lib/language')();
const bodyParser = require('body-parser');

require('should');

describe('Alexa REST api', function ( ) {
  this.timeout(10000);
  const apiRoot = require('../lib/api/root');
  const api = require('../lib/api/');
  before(function (done) {
    var env = require('../env')( );
    env.settings.enable = ['alexa'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.app.use('/api', bodyParser({
        limit: 1048576 * 50
      }), apiRoot(env, ctx));

      self.app.use('/api/v1', bodyParser({
        limit: 1048576 * 50
      }), api(env, ctx));
      done( );
    });
  });

  it('Launch Request', function (done) {
    request(this.app)
      .post('/api/v1/alexa')
      .send({
        "request": {
          "type": "LaunchRequest",
          "locale": "en-US"
        }
      })
      .expect(200)
      .end(function (err, res)  {
        if (err) return done(err);

        const launchText = 'What would you like to check on Nightscout?';

        res.body.response.outputSpeech.text.should.equal(launchText);
        res.body.response.reprompt.outputSpeech.text.should.equal(launchText);
        res.body.response.shouldEndSession.should.equal(false);
        done( );
      });
  });

  it('Launch Request With Intent', function (done) {
    request(this.app)
      .post('/api/v1/alexa')
      .send({
        "request": {
          "type": "LaunchRequest",
          "locale": "en-US",
          "intent": {
            "name": "UNKNOWN"
          }
        }
      })
      .expect(200)
      .end(function (err, res)  {
        if (err) return done(err);

        const unknownIntentText = 'I\'m sorry, I don\'t know what you\'re asking for.';

        res.body.response.outputSpeech.text.should.equal(unknownIntentText);
        res.body.response.shouldEndSession.should.equal(true);
        done( );
      });
  });

  it('Session Ended', function (done) {
    request(this.app)
      .post('/api/v1/alexa')
      .send({
        "request": {
          "type": "SessionEndedRequest",
          "locale": "en-US"
        }
      })
      .expect(200)
      .end(function (err)  {
        if (err) return done(err);

        done( );
      });
  });
});

