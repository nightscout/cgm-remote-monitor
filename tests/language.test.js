'use strict';

const fs = require('fs');
const path = require('path');

require('should');

describe('language', function ( ) {

  it('use English by default', function () {
    var language = require('../lib/language')();
    language.translate('Carbs').should.equal('Carbs');
  });

  it('replace strings in translations', function () {
    var language = require('../lib/language')();
    language.translate('%1 records deleted', '1').should.equal('1 records deleted');
    language.translate('%1 records deleted', 1).should.equal('1 records deleted');
    language.translate('%1 records deleted', {params: ['1']}).should.equal('1 records deleted');
    language.translate('Sensor age %1 days %2 hours', '1', '2').should.equal('Sensor age 1 days 2 hours');
  });

  it('translate to French', function () {
    var language = require('../lib/language')();
    language.set('fr');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('Glucides');
  });

  it('translate to Czech', function () {
    var language = require('../lib/language')();
    language.set('cs');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('Sacharidy');
  });

  it('translate to Czech uppercase', function () {
    var language = require('../lib/language')();
    language.set('cs');
    language.loadLocalization(fs);
    language.translate('carbs', { ci: true }).should.equal('Sacharidy');
  });

  it('translate to Taiwan Traditional Chinese', function () {
    var language = require('../lib/language')();
    language.set('zh_tw');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('碳水化合物');
  });

  it('labels zh_tw as Taiwan Traditional Chinese', function () {
    var language = require('../lib/language')();
    language.get('zh_tw').language.should.equal('繁體中文（台灣）');
  });

  it('preserves Traditional Chinese volume units and uploader battery labels', function () {
    var language = require('../lib/language')();
    language.set('zh_tw');
    language.loadLocalization(fs);
    language.translate('ml').should.equal('毫升');
    language.translate('virtAsstTitleUploaderBattery').should.equal('當前上傳器電池');
  });

  it('preserves Swedish report filters and record count placeholders', function () {
    var language = require('../lib/language')();
    language.set('sv');
    language.loadLocalization(fs);
    language.translate('Days with food').should.equal('Dagar med mat');
    language.translate('Days with notes containing').should.equal('Dagar med anteckningar som innehåller');
    language.translate('Days with event type').should.equal('Dagar med händelsetyp');
    language.translate('All event types').should.equal('Alla händelsetyper');
    language.translate('Showing %1 of %2 records', '3', '10').should.equal('Visar 3 av 10 poster');
  });

  it('loads Lithuanian through its registered language code', function () {
    var language = require('../lib/language')();
    language.get('lt').language.should.equal('Lietuvių');
    language.getFilename('lt').should.equal('lt_LT.json');
    language.set('lt');
    language.speechCode.should.equal('lt-LT');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('Angliavandeniai');
    language.translate('ml').should.equal('ml');
    language.translate('virtAsstTitleUploaderBattery').should.equal('Įkėlėjo baterija');
    language.translate('Sensor age %1 days %2 hours', '2', '3').should.equal('Sensoriaus amžius: 2 d. 3 val.');
    language.translate('Showing %1 of %2 records', '3', '10').should.equal('Showing 3 of 10 records');
  });

  it('uses Lithuanian labels for the missing-data time pill', function () {
    var language = require('../lib/language')();
    language.set('lt');
    language.loadLocalization(fs);
    var timeago = require('../lib/plugins/timeago')({ language: language });
    timeago.calcDisplay().should.deepEqual({ label: 'prieš', shortLabel: 'prieš' });
    language.translate('min ago').should.equal('min.');
    language.translate('hour ago').should.equal('val.');
  });

  it('keeps Lithuanian keys and placeholders aligned with the English catalog', function () {
    var english = JSON.parse(fs.readFileSync(path.join(__dirname, '../translations/en/en.json'), 'utf8'));
    var lithuanian = JSON.parse(fs.readFileSync(path.join(__dirname, '../translations/lt_LT.json'), 'utf8'));
    Object.keys(lithuanian).sort().should.deepEqual(Object.keys(english).sort());
    Object.keys(english).forEach(function (key) {
      lithuanian[key].should.be.a.String().and.not.empty();
      var placeholders = /%\d+|\{\d+\}/g;
      (lithuanian[key].match(placeholders) || []).sort().should.deepEqual((english[key].match(placeholders) || []).sort());
    });
  });

  it('loads the registered Slovenian catalog without a missing-file error', function () {
    var language = require('../lib/language')();
    language.set('sl');
    language.getFilename('sl').should.equal('sl_SI.json');
    language.speechCode.should.equal('sl-SI');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('OH');
  });

  it('substitutes the Russian status update time without losing values', function () {
    var language = require('../lib/language')();
    language.set('ru');
    language.loadLocalization(fs);
    language.translate('virtAsstStatus', '5.5', 'стабильно', '12:30')
      .should.equal('5.5, стабильно, последнее обновление 12:30.');
  });

  it('fallback to English filename for unsupported language codes', function () {
    var language = require('../lib/language')();
    language.getFilename('unknown_language').should.equal('en/en.json');
  });

  it('parse every translation file as valid JSON', function () {
    function parseTranslationTree (dirPath) {
      fs.readdirSync(dirPath, { withFileTypes: true }).forEach(function(entry) {
        var entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          parseTranslationTree(entryPath);
          return;
        }

        if (path.extname(entry.name) === '.json') {
          JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        }
      });
    }

    parseTranslationTree(path.join(__dirname, '..', 'translations'));
  });

});
