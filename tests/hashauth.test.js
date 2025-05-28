'use strict';

require('should');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

describe('hashauth', function ( ) {
  this.timeout(50000); // TODO: see why this test takes longer on Travis to complete

  var self = this;
  var headless = require('./fixtures/headless')(benv, this);
  let originalWindowCrypto; // Needed to store and restore window.crypto

  before(function (done) {
    done( );
  });

  after(function (done) {
    // cleanup js-storage as it evaluates if the test is running in the window or not when first required
    delete require.cache[require.resolve('js-storage')];
    done( );
  });

  beforeEach(function (done) {
    headless.setup({mockAjax: true}, function() {
      // This function is called by headless.setup when its environment is ready.
      // JSDOM's window object should be available here.

      if (typeof window !== 'undefined') {
        originalWindowCrypto = window.crypto; // Store the original window.crypto

        // Ensure TextEncoder and TextDecoder are available in the test environment
        // as hashauth.processSecret relies on them.
        if (typeof TextEncoder === 'undefined') {
          global.TextEncoder = require('util').TextEncoder;
        }
        if (typeof TextDecoder === 'undefined') {
          global.TextDecoder = require('util').TextDecoder;
        }

        // Ensure window.crypto exists and is an object
        let cryptoRef = window.crypto;
        if (!cryptoRef || typeof cryptoRef !== 'object') {
          cryptoRef = {};
          window.crypto = cryptoRef; // Assign to window only if we created it
        }

        // Ensure cryptoRef.subtle exists and is an object
        if (!cryptoRef.subtle || typeof cryptoRef.subtle !== 'object') {
          cryptoRef.subtle = {};
        }

        // Mock only the digest function on the (potentially augmented) cryptoRef.subtle
        cryptoRef.subtle.digest = async function(algorithm, dataToHash) {
          let algoName = '';
          if (typeof algorithm === 'string') {
            algoName = algorithm.toUpperCase();
          } else if (typeof algorithm === 'object' && algorithm.name) {
            algoName = algorithm.name.toUpperCase();
          }

          if (algoName === 'SHA-1') {
            // The tests use 'this is my long pass phrase' which hashes to 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
            const inputText = new TextDecoder().decode(dataToHash);
            if (inputText === 'this is my long pass phrase') {
              const expectedHashHex = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
              const bytes = new Uint8Array(expectedHashHex.length / 2);
              for (let i = 0; i < expectedHashHex.length; i += 2) {
                bytes[i / 2] = parseInt(expectedHashHex.substring(i, i + 2), 16);
              }
              return Promise.resolve(bytes.buffer);
            } else {
              console.warn('SubtleCrypto mock (SHA-1) called with unexpected data:', inputText);
              return Promise.reject(new Error('SubtleCrypto mock: Unexpected data for SHA-1'));
            }
          }
          console.warn('SubtleCrypto mock called with unsupported algorithm:', algorithm);
          return Promise.reject(new Error('SubtleCrypto mock: Algorithm not supported'));
        };
      } else {
        console.error('hashauth.test.js: window object not found in headless.setup callback. Cannot mock crypto.subtle.digest.');
      }
      done(); // Signal completion of beforeEach
    });
  });

  afterEach(function (done) {
    if (typeof window !== 'undefined') {
      window.crypto = originalWindowCrypto; // Restore original window.crypto
      originalWindowCrypto = undefined; // Clear the stored reference
    }
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

  it ('should store hash and the remove authentication', function (done) {
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

    hashauth.processSecret('this is my long pass phrase', true, function(success) {
      if (!success) {
        return done(new Error('processSecret failed during store hash and remove authentication test'));
      }
      hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
      localStorage.get('apisecrethash').should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
      hashauth.isAuthenticated().should.equal(true);

      hashauth.removeAuthentication();
      hashauth.isAuthenticated().should.equal(false);
      done();
    });
  });

  it ('should not store hash', function (done) {
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

    hashauth.processSecret('this is my long pass phrase', false, function(success) {
      if (!success) {
        return done(new Error('processSecret failed during not store hash test'));
      }
      hashauth.hash().should.equal('b723e97aa97846eb92d5264f084b2823f57c4aa1');
      var testnull = (localStorage.get('apisecrethash')===null);
      testnull.should.equal(true);
      hashauth.isAuthenticated().should.equal(true);
      done();
    });
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
