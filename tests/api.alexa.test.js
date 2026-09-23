'use strict';

const fs = require('fs');
const moment = require('moment');
const request = require('supertest');
const language = require('../lib/language')(fs);

const bodyParser = require('body-parser');

require('should');

describe('Alexa REST api', function ( ) {
  this.timeout(10000);
  const apiRoot = require('../lib/api/root');
  const api = require('../lib/api/');
  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')( );
    env.settings.enable = ['alexa'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
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

  // Alexa can send request types this skill has no case for - for example
  // System.ExceptionEncountered, which Amazon sends after a response it could
  // not use. With no default in the switch, nothing answered and the request
  // stayed open until the client gave up. Amazon's documentation says a skill
  // cannot return a response to that request (or to SessionEndedRequest), so
  // it gets the same empty answer SessionEndedRequest does.
  it('answers a request type it does not handle instead of hanging', function (done) {
    request(this.app)
      .post('/api/v1/alexa')
      .timeout(2000)
      .send({
        "request": {
          "type": "System.ExceptionEncountered",
          "locale": "en-US"
        }
      })
      .expect(200)
      .end(function (err, res)  {
        if (err) return done(err);

        res.body.should.equal('');
        done( );
      });
  });

  // The request carries the caller's locale, and both the language instance and
  // moment's locale are shared by the whole process. Setting either one from a
  // request hands the caller's language to every later request in the server.
  it('does not re-language the process from the request locale', function (done) {
    var self = this;
    var languageBefore = this.ctx.language.lang;
    var speechCodeBefore = this.ctx.language.speechCode;
    var momentLocaleBefore = moment.locale();

    // Non-vacuity: if these were already German the assertions below would hold
    // for the wrong reason.
    languageBefore.should.not.equal('de');
    momentLocaleBefore.should.not.equal('de');

    request(this.app)
      .post('/api/v1/alexa')
      .send({
        "request": {
          "type": "LaunchRequest",
          "locale": "de-DE"
        }
      })
      .expect(200)
      .end(function (err, res)  {
        if (err) return done(err);

        // Non-vacuity: the route really did run and handle this request.
        res.body.response.outputSpeech.text.should.equal('What would you like to check on Nightscout?');

        self.ctx.language.lang.should.equal(languageBefore);
        self.ctx.language.speechCode.should.equal(speechCodeBefore);
        moment.locale().should.equal(momentLocaleBefore);
        done( );
      });
  });

});
