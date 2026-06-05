'use strict';

var should = require('should');
var fs = require('fs');
var os = require('os');
var path = require('path');

describe('env', function () {
  var tempDirs = [];

  function writeTempFile(data) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-api-secret-'));
    const fullPath = path.join(tempDir, 'api_secret');
    tempDirs.push(tempDir);
    fs.writeFileSync(fullPath, data);
    return fullPath;
  }

  afterEach(function () {
    delete process.env.API_SECRET;
    delete process.env.API_SECRET_FILE;

    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('should not set the API key without API_SECRET or API_SECRET_FILE', function () {
    delete process.env.API_SECRET;
    delete process.env.API_SECRET_FILE;

    var env = require( '../lib/server/env' )();

    env.enclave.isApiKeySet().should.equal(false);
  });

  it('should read and trim the API key from API_SECRET_FILE if it is valid', function () {
    const apiSecretFile = 'this is another pass phrase\n';
    const hashFile = 'c79c6db1070da3537d0162e60647b0a588769f8d';
    process.env.API_SECRET_FILE = writeTempFile(apiSecretFile);

    var env = require( '../lib/server/env' )();

    env.enclave.isApiKeySet().should.equal(true);
    env.enclave.isApiKey(hashFile).should.equal(true);
  });

  it('should raise an error when API_SECRET_FILE does not exist', function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-api-secret-'));
    tempDirs.push(tempDir);
    const nonexistentPath = path.join(tempDir, 'missing_api_secret');
    process.env.API_SECRET_FILE = nonexistentPath;

    var env = require( '../lib/server/env' )();

    env.enclave.isApiKeySet().should.equal(false);
    env.err.length.should.equal(1);

    const error = env.err.pop();
    error.should.have.property('desc');
    error.desc.should.match(/API_SECRET_FILE/);
    error.desc.should.match(/no such file or directory/);
  });

  it('should use API_SECRET when API_SECRET_FILE is also specified', function () {
    const apiSecretEnv = 'this is my long pass phrase';
    const hashEnv = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    process.env.API_SECRET = apiSecretEnv;

    const apiSecretFile = 'this is another pass phrase';
    const hashFile = 'c79c6db1070da3537d0162e60647b0a588769f8d';
    process.env.API_SECRET_FILE = writeTempFile(apiSecretFile);

    var env = require( '../lib/server/env' )();

    env.enclave.isApiKeySet().should.equal(true);
    env.enclave.isApiKey(hashEnv).should.equal(true);
    env.enclave.isApiKey(hashFile).should.equal(false);
  });

  it( 'show the right plugins', function () {
    process.env.SHOW_PLUGINS = 'iob';
    process.env.ENABLE = 'iob cob';

    var env = require( '../lib/server/env' )();
    var showPlugins = env.settings.showPlugins;
    showPlugins.should.containEql( 'iob' );
    showPlugins.should.containEql( 'delta' );
    showPlugins.should.containEql( 'direction' );
    showPlugins.should.containEql( 'upbat' );

    delete process.env.SHOW_PLUGINS;
    delete process.env.ENABLE;
  } );

  it( 'get extended settings', function () {
    process.env.ENABLE = 'scaryplugin';
    process.env.SCARYPLUGIN_DO_THING = 'yes';

    var env = require( '../lib/server/env' )();
    env.settings.isEnabled( 'scaryplugin' ).should.equal( true );

    //Note the camelCase
    env.extendedSettings.scaryplugin.doThing.should.equal( 'yes' );

    delete process.env.ENABLE;
    delete process.env.SCARYPLUGIN_DO_THING;
  } );

  it( 'add pushover to enable if one of the env vars is set', function () {
    process.env.PUSHOVER_API_TOKEN = 'abc12345';

    var env = require( '../lib/server/env' )();
    env.settings.enable.should.containEql( 'pushover' );
    env.extendedSettings.pushover.apiToken.should.equal( 'abc12345' );

    delete process.env.PUSHOVER_API_TOKEN;
  } );

  it( 'add pushover to enable if one of the weird azure env vars is set', function () {
    process.env.CUSTOMCONNSTR_PUSHOVER_API_TOKEN = 'abc12345';

    var env = require( '../lib/server/env' )();
    env.settings.enable.should.containEql( 'pushover' );
    env.extendedSettings.pushover.apiToken.should.equal( 'abc12345' );

    delete process.env.PUSHOVER_API_TOKEN;
  } );

  it( 'readENVTruthy ', function () {
    process.env.INSECURE_USE_HTTP = 'true';
    var env = require( '../lib/server/env' )();
    env.insecureUseHttp.should.be.true();
    process.env.INSECURE_USE_HTTP = 'false';
    env = require( '../lib/server/env' )();
    env.insecureUseHttp.should.be.false();
    process.env.INSECURE_USE_HTTP = 'not set ok, so use default value false';
    env = require( '../lib/server/env' )();
    env.insecureUseHttp.should.be.false();
    delete process.env.INSECURE_USE_HTTP; // unset INSECURE_USE_HTTP
    process.env.SECURE_HSTS_HEADER = 'true';
    env = require( '../lib/server/env' )();
    env.insecureUseHttp.should.be.false(); // not defined should be false
    env.secureHstsHeader.should.be.true();
  });

  describe('HOSTNAME', function () {
    var originalHostname;
    var originalNightscoutHostname;
    var originalContainer;

    beforeEach(function () {
      originalHostname = process.env.HOSTNAME;
      originalNightscoutHostname = process.env.NIGHTSCOUT_HOSTNAME;
      originalContainer = process.env.container;

      delete process.env.HOSTNAME;
      delete process.env.NIGHTSCOUT_HOSTNAME;
      delete process.env.container;
    });

    afterEach(function () {
      if (originalHostname === undefined) {
        delete process.env.HOSTNAME;
      } else {
        process.env.HOSTNAME = originalHostname;
      }

      if (originalNightscoutHostname === undefined) {
        delete process.env.NIGHTSCOUT_HOSTNAME;
      } else {
        process.env.NIGHTSCOUT_HOSTNAME = originalNightscoutHostname;
      }

      if (originalContainer === undefined) {
        delete process.env.container;
      } else {
        process.env.container = originalContainer;
      }
    });

    it('prefers NIGHTSCOUT_HOSTNAME over legacy HOSTNAME', function () {
      process.env.NIGHTSCOUT_HOSTNAME = '0.0.0.0';
      process.env.HOSTNAME = 'legacy-hostname';

      var env = require('../lib/server/env')();

      env.HOSTNAME.should.equal('0.0.0.0');
    });

    it('treats empty NIGHTSCOUT_HOSTNAME as all interfaces', function () {
      process.env.NIGHTSCOUT_HOSTNAME = '';
      process.env.HOSTNAME = 'legacy-hostname';

      var env = require('../lib/server/env')();

      should(env.HOSTNAME).equal(null);
    });

    it('keeps legacy HOSTNAME when explicitly configured outside Docker', function () {
      process.env.HOSTNAME = '127.0.0.1';

      var env = require('../lib/server/env')();

      env.HOSTNAME.should.equal('127.0.0.1');
    });

    it('ignores Docker generated HOSTNAME', function () {
      process.env.container = 'docker';
      process.env.HOSTNAME = os.hostname();

      var env = require('../lib/server/env')();

      should(env.HOSTNAME).equal(null);
    });
  });

  describe( 'DISPLAY_UNITS', function () {
    const MMOL = 'mmol';
    const MGDL = 'mg/dl';
    describe ( 'mmol', function () {
      it( 'mmol => mmol', function () {
        process.env.DISPLAY_UNITS = MMOL;
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MMOL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'mmol/l => mmol', function () {
        process.env.DISPLAY_UNITS = 'mmol/l';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MMOL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'mmol/L => mmol', function () {
        process.env.DISPLAY_UNITS = 'mmol/L';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MMOL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'MMOL => mmol', function () {
        process.env.DISPLAY_UNITS = 'MMOL';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MMOL );
        delete process.env.DISPLAY_UNITS;
      } );
    } );

    describe ( 'mg/dl', function () {
      it( 'mg/dl => mg/dl', function () {
        process.env.DISPLAY_UNITS = MGDL;
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'mg/dL => mg/dl', function () {
        process.env.DISPLAY_UNITS = 'mg/dL';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'MG/DL => mg/dl', function () {
        process.env.DISPLAY_UNITS = 'MG/DL';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( 'mgdl => mg/dl', function () {
        process.env.DISPLAY_UNITS = 'mgdl';
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );
    } );

    describe ( 'default: mg/dl', function () {
      it( '<random> => mg/dl', function () {
        var random;
        while (!random || random.toLowerCase() === MGDL)
          random = [...Array(~~(Math.random()*20)+1)].map(i=>(~~(Math.random()*36)).toString(36)).join('');

        process.env.DISPLAY_UNITS = random;
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );

      it( '<null> => mg/dl', function () {
        delete process.env.DISPLAY_UNITS;
        var env = require( '../lib/server/env' )();
        env.settings.units.should.equal( MGDL );
        delete process.env.DISPLAY_UNITS;
      } );
    } );
  } );
})
