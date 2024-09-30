'use strict';

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('env', function () {
  function writeTempFile(fileName, data) {
    const fullPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(fullPath, data);
    return fullPath;
  }

  it('should not set the API key without API_SECRET or API_SECRET_FILE', function () {
    delete process.env.API_SECRET;
    var env = require( '../lib/server/env' )();
    env.enclave.isApiKeySet().should.equal(false);
  });

  it('should read the API key from API_SECRET_FILE if it is valid', function () {
    const apiSecretFile = 'this is another pass phrase';
    const hashFile = 'c79c6db1070da3537d0162e60647b0a588769f8d';
    process.env.API_SECRET_FILE = writeTempFile('api_secret_file', apiSecretFile);

    var env = require( '../lib/server/env' )();
    env.enclave.isApiKeySet().should.equal(true);
    env.enclave.isApiKey(hashFile).should.equal(true);

    fs.rmSync(process.env.API_SECRET_FILE);
    delete process.env.API_SECRET_FILE;
  });

  it('should raise an error when API_SECRET_FILE does not exist', function () {
    const nonexistentPath = path.join(os.tmpdir(), 'api_secret_file');
    process.env.API_SECRET_FILE = nonexistentPath;

    var env = require( '../lib/server/env' )();
    env.enclave.isApiKeySet().should.equal(false);
    env.err.length.should.equal(1);

    const error = env.err.pop();
    error.should.have.property('desc');
    error.desc.should.match(/API_SECRET_FILE/);
    error.desc.should.match(/no such file or directory/);

    delete process.env.API_SECRET_FILE;
  });

  it('should use API_SECRET when API_SECRET_FILE is also specified', function () {
    const apiSecretEnv = 'this is my long pass phrase';
    const hashEnv = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    process.env.API_SECRET = apiSecretEnv;

    const apiSecretFile = 'this is another pass phrase';
    const hashFile = 'c79c6db1070da3537d0162e60647b0a588769f8d';
    process.env.API_SECRET_FILE = writeTempFile('api_secret_file', apiSecretFile);

    var env = require( '../lib/server/env' )();
    env.enclave.isApiKeySet().should.equal(true);
    env.enclave.isApiKey(hashEnv).should.equal(true);
    env.enclave.isApiKey(hashFile).should.equal(false);

    fs.rmSync(process.env.API_SECRET_FILE);
    delete process.env.API_SECRET_FILE;
    delete process.env.API_SECRET;
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
