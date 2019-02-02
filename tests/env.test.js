'use strict';

require('should');

describe('env', function ( ) {
  it( 'show the right plugins', function () {
    process.env.SHOW_PLUGINS = 'iob';
    process.env.ENABLE = 'iob cob';

    var env = require( '../env' )();
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

    var env = require( '../env' )();
    env.settings.isEnabled( 'scaryplugin' ).should.equal( true );

    //Note the camelCase
    env.extendedSettings.scaryplugin.doThing.should.equal( 'yes' );

    delete process.env.ENABLE;
    delete process.env.SCARYPLUGIN_DO_THING;
  } );

  it( 'add pushover to enable if one of the env vars is set', function () {
    process.env.PUSHOVER_API_TOKEN = 'abc12345';

    var env = require( '../env' )();
    env.settings.enable.should.containEql( 'pushover' );
    env.extendedSettings.pushover.apiToken.should.equal( 'abc12345' );

    delete process.env.PUSHOVER_API_TOKEN;
  } );

  it( 'add pushover to enable if one of the weird azure env vars is set', function () {
    process.env.CUSTOMCONNSTR_PUSHOVER_API_TOKEN = 'abc12345';

    var env = require( '../env' )();
    env.settings.enable.should.containEql( 'pushover' );
    env.extendedSettings.pushover.apiToken.should.equal( 'abc12345' );

    delete process.env.PUSHOVER_API_TOKEN;
  } );

  it( 'readENVTruthy ', function () {
    process.env.INSECURE_USE_HTTP = 'true';
    var env = require( '../env' )();
    env.insecureUseHttp.should.be.true();
    process.env.INSECURE_USE_HTTP = 'false';
    env = require( '../env' )();
    env.insecureUseHttp.should.be.false();
    process.env.INSECURE_USE_HTTP = 'not set ok, so use default value false';
    env = require( '../env' )();
    env.insecureUseHttp.should.be.false();
    delete process.env.INSECURE_USE_HTTP; // unset INSECURE_USE_HTTP
    process.env.SECURE_HSTS_HEADER = 'true';
    env = require( '../env' )();
    env.insecureUseHttp.should.be.false(); // not defined should be false
    env.secureHstsHeader.should.be.true();
  });
})
