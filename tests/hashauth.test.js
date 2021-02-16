'use strict';

require('should');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

describe('hashauth', function ( ) {
  this.timeout(50000); // TODO: see why this test takes longer on Travis to complete

  var self = this;
  var headless = require('./fixtures/headless')(benv, this);

  before(function (done) {
    done( );
  });

  after(function (done) {
    // cleanup js-storage as it evaluates if the test is running in the window or not when first required
    delete require.cache[require.resolve('js-storage')];
    done( );
  });

  beforeEach(function (done) {
    headless.setup({mockAjax: true}, done);
  });

  afterEach(function (done) {
    headless.teardown( );
    done( );
  });
  /*
  before(function (done) {
    benv.setup(function() {
      self.$ = require('jquery');
      self.$.localStorage = require('./fixtures/localstorage');

      self.$.fn.tooltip = function mockTooltip ( ) { };

      var indexHtml = read(__dirname + '/../static/index.html', 'utf8');
      self.$('body').html(indexHtml);

      var d3 = require('d3');
      //disable all d3 transitions so most of the other code can run with jsdom
      d3.timer = function mockTimer() { };

      benv.expose({
        $: self.$
        , jQuery: self.$
        , d3: d3
        , io: {
          connect: function mockConnect ( ) {
            return {
              on: function mockOn ( ) { }
            };
          }
        }
      });
      done();
    });
  });

  after(function (done) {
    benv.teardown();
    done();
  });
  */

  it ('should make module unauthorized', function () {
    var client = require('../lib/client');
    var hashauth = require('../lib/client/hashauth');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = false;
      next(true); 
    };

    client.init();

    hashauth.inlineCode().indexOf('Unauthorized').should.be.greaterThan(0);
    hashauth.isAuthenticated().should.equal(false);
    var testnull = (hashauth.hash()===null);
    testnull.should.equal(true);
  });

  it ('should make module authorized', function () {
    var client = require('../lib/client');
    var hashauth = require('../lib/client/hashauth');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init();

    hashauth.inlineCode().indexOf('Admin authorized').should.be.greaterThan(0);
    hashauth.isAuthenticated().should.equal(true);
  });

  it ('should store hash and the remove authentication', function () {
    var client = require('../lib/client');
    var hashauth = require('../lib/client/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };
    hashauth.updateSocketAuth = function mockUpdateSocketAuth() {};

    client.init();

    hashauth.processSecret('this is my long pass phrase',true);
    
    hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    localStorage.get('apisecrethash').should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    hashauth.isAuthenticated().should.equal(true);
    
    hashauth.removeAuthentication();
    hashauth.isAuthenticated().should.equal(false);
  });

  it ('should not store hash', function () {
    var client = require('../lib/client');
    var hashauth = require('../lib/client/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');

    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init();

    hashauth.processSecret('this is my long pass phrase',false);
    
    hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    var testnull = (localStorage.get('apisecrethash')===null);
    testnull.should.equal(true);
    hashauth.isAuthenticated().should.equal(true);
  });

  it ('should report secret too short', function () {
    var client = require('../lib/client');
    var hashauth = require('../lib/client/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');

    hashauth.init(client, self.$);

    client.init();

    window.alert = function mockConfirm (message) {
      function containsLine (line) {
        message.indexOf(line).should.be.greaterThan(-1);
      }
      containsLine('Too short API secret');
      return true;
    };

    hashauth.processSecret('short passp',false);
  });
});
