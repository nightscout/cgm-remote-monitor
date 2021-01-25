'use strict';

const fs = require('fs');

require('should');

describe('language', function ( ) {

  it('use English by default', function () {
    var language = require('../lib/language')();
    language.translate('Carbs').should.equal('Carbs');
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

});
