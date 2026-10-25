'use strict';

const assert = require('assert');
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const moment = require('moment-timezone');

// Exercise the real routes, assistant dispatch and shared glucose/status
// handlers. Only storage and authorization are stubbed; no MongoDB is needed.
describe('Voice replies use the configured server language', function () {
  const now = Date.UTC(2026, 0, 1, 12, 5);
  let previousLocale;

  beforeEach(function () {
    previousLocale = moment.locale();
  });

  afterEach(function () {
    moment.locale(previousLocale);
  });

  function makeApp(serverLanguage, assistant) {
    const language = require('../lib/language')(fs);
    language.set(serverLanguage);
    language.loadLocalization(fs);
    const ctx = {
      language, moment,
      authorization: { isPermitted: () => (req, res, next) => next() },
      plugins: { eachEnabledPlugin: () => {} },
      entries: { list: (query, callback) => {
        assert.equal(query.count, 1);
        callback(null, [{ sgv: 100, direction: 'Flat', date: now - 5 * 60000 }]);
      } },
      sbx: { time: now, scaleMgdl: value => value }
    };
    ctx[assistant === 'alexa' ? 'alexa' : 'googleHome'] = require('../lib/plugins/' + assistant)();
    ctx.virtAsstBase = require('../lib/plugins/virtAsstBase')({}, ctx);
    const next = (req, res, done) => done();
    const wares = {
      sendJSONStatus: next, rawParser: next,
      jsonParser: express.json(), urlencodedParser: express.urlencoded({ extended: true })
    };
    const app = express();
    app.use('/api/v1', require('../lib/api/' + assistant)(app, wares, ctx));
    return { app, language };
  }

  const languages = [
    ['fr', 'il y a 5 minutes'],
    ['dk', '5 minutter siden'],
    ['br', 'há 5 minutos'],
    ['zh_tw', '5 分鐘前'],
    ['en', '5 minutes ago']
  ];

  ['alexa', 'googlehome'].forEach(function (assistant) {
    ['MetricNow', 'NSStatus'].forEach(function (intent) {
      languages.forEach(function ([serverLanguage, age]) {
        it(assistant + ' ' + intent + ' localizes time in ' + serverLanguage + ' without changing shared state', async function () {
          // Keep the process locale different from the configured language.
          moment.locale(serverLanguage === 'en' ? 'fr' : 'en');
          const globalLocale = moment.locale();
          const { app, language } = makeApp(serverLanguage, assistant);
          const speechCode = language.speechCode;
          const translations = language.translations;
          const expected = language.translate('virtAsstStatus', {
            params: [100, language.translate('Flat'), age]
          });
          const body = assistant === 'alexa' ? {
            request: {
              type: 'IntentRequest', locale: 'de-DE',
              intent: Object.assign({ name: intent }, intent === 'MetricNow' ? {
                slots: { metric: { resolutions: { resolutionsPerAuthority: [{
                  status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: 'bg' } }]
                }] } } }
              } : {})
            }
          } : {
            queryResult: {
              languageCode: 'de-DE', intent: { displayName: intent }, parameters: { metric: 'bg' }
            }
          };
          const response = await request(app).post('/api/v1/' + assistant).send(body).expect(200);
          const speech = assistant === 'alexa' ? response.body.response.outputSpeech.text
            : response.body.payload.google.richResponse.items[0].simpleResponse.textToSpeech;
          assert.equal(speech, expected);
          assert.equal(language.lang, serverLanguage);
          assert.equal(language.speechCode, speechCode);
          assert.strictEqual(language.translations, translations);
          assert.equal(moment.locale(), globalLocale);
        });
      });
    });
  });
});
