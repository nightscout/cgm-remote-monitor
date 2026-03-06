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

  it('translate to Traditional Chinese', function () {
    var language = require('../lib/language')();
    language.set('zh_tw');
    language.loadLocalization(fs);
    language.translate('Carbs').should.equal('碳水');
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
