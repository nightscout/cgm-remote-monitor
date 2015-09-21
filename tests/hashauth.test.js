'use strict';

require('should');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

describe('hashauth', function ( ) {
  var self = this;
  before(function (done) {
    benv.setup(function() {
      self.$ = require('jquery');
      self.$.localStorage = require('./fixtures/localstorage');

      self.$.fn.tipsy = function mockTipsy ( ) { };

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

  it ('should make module unauthorized', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    var hashauth = require('../lib/hashauth');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = false;
      next(true); 
    };

    client.init(serverSettings, plugins);

    hashauth.inlineCode().indexOf('Device not authenticated').should.be.greaterThan(0);
    hashauth.isAuthenticated().should.equal(false);
    var testnull = (hashauth.hash()===null);
    testnull.should.equal(true);
  });

  it ('should make module authorized', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    var hashauth = require('../lib/hashauth');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init(serverSettings, plugins);

    hashauth.inlineCode().indexOf('Device authenticated').should.be.greaterThan(0);
    hashauth.isAuthenticated().should.equal(true);
  });

  it ('should store hash and the remove authentication', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    var hashauth = require('../lib/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');
    
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init(serverSettings, plugins);

    hashauth.processSecret('this is my long pass phrase',true);
    
    hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    localStorage.get('apisecrethash').should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    hashauth.isAuthenticated().should.equal(true);
    
    hashauth.removeAuthentication();
    hashauth.isAuthenticated().should.equal(false);
  });

  it ('should not store hash', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    var hashauth = require('../lib/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');

    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init(serverSettings, plugins);

    hashauth.processSecret('this is my long pass phrase',false);
    
    hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
    var testnull = (localStorage.get('apisecrethash')===null);
    testnull.should.equal(true);
    hashauth.isAuthenticated().should.equal(true);
  });

  it ('should report secret too short', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    var hashauth = require('../lib/hashauth');
    var localStorage = require('./fixtures/localstorage');   
    
    localStorage.remove('apisecrethash');

    hashauth.init(client,$);

    client.init(serverSettings, plugins);

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
