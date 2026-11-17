'use strict';

const fs = require('fs');
const moment = require('moment');
const request = require('supertest');
const language = require('../lib/language')(fs);

const express = require('express');

require('should');

describe('Google Home REST api', function ( ) {
  this.timeout(10000);
  const apiRoot = require('../lib/api/root');
  const api = require('../lib/api/');
  before(function (done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')( );
    env.settings.enable = ['googlehome'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    require('../lib/middleware/configure-request')(this.app);
    this.app.enable('api');
    var self = this;
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api', express.json({limit: 1048576 * 50}), express.urlencoded({extended: true, limit: 1048576 * 50}), apiRoot(env, ctx));

      self.app.use('/api/v1', express.json({limit: 1048576 * 50}), express.urlencoded({extended: true, limit: 1048576 * 50}), api(env, ctx));
      done( );
    });
  });

  function unknownIntent (languageCode) {
    return {
      queryResult: {
        languageCode: languageCode
        , intent: { displayName: 'UNKNOWN' }
        , parameters: { metric: 'blood glucose' }
      }
    };
  }

  const unknownIntentText = 'I\'m sorry, I don\'t know what you\'re asking for.';

  it('answers an unknown intent', function (done) {
    request(this.app)
      .post('/api/v1/googlehome')
      .send(unknownIntent('en-US'))
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        res.body.payload.google.richResponse.items[0].simpleResponse.textToSpeech
          .should.equal(unknownIntentText);
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
      .post('/api/v1/googlehome')
      .send(unknownIntent('de-DE'))
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);

        // Non-vacuity: the route really did run and handle this request.
        res.body.payload.google.richResponse.items[0].simpleResponse.textToSpeech
          .should.equal(unknownIntentText);

        self.ctx.language.lang.should.equal(languageBefore);
        self.ctx.language.speechCode.should.equal(speechCodeBefore);
        moment.locale().should.equal(momentLocaleBefore);
        done( );
      });
  });

});
