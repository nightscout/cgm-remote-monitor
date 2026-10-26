'use strict';

var fs = require('fs');
var path = require('path');

var should = require('should');

function captureWarnings (fn) {
  var warnings = [];
  var original = console.warn;
  console.warn = function capture () {
    warnings.push(Array.prototype.slice.call(arguments).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

function registerWith (enable, mode) {
  var plugins = require('../lib/plugins/')({
    settings: { enable: enable }
    , language: require('../lib/language')()
  });
  var warnings = captureWarnings(function register () {
    if (mode === 'server') {
      plugins.registerServerDefaults();
    } else {
      plugins.registerClientDefaults();
    }
  });
  var armed = [];
  plugins.eachEnabledPlugin(function each (plugin) { armed.push(plugin.name); });
  return { plugins: plugins, warnings: warnings, armed: armed };
}

describe('Plugins', function ( ) {


  it('should find client plugins, but not server only plugins', function (done) {
    var plugins = require('../lib/plugins/')({
      settings: { }
      , language: require('../lib/language')()
    }).registerClientDefaults();

    plugins('bgnow').name.should.equal('bgnow');
    plugins('rawbg').name.should.equal('rawbg');

    //server only plugin
    should.not.exist(plugins('treatmentnotify'));

    done( );
  });

  it('should find sever plugins, but not client only plugins', function (done) {
    var plugins = require('../lib/plugins/')({
      settings: { }
      , language: require('../lib/language')()
    }).registerServerDefaults();

    plugins('rawbg').name.should.equal('rawbg');
    plugins('treatmentnotify').name.should.equal('treatmentnotify');

    //client only plugin
    should.not.exist(plugins('cannulaage'));

    done( );
  });

  describe('ENABLE entries that match no plugin', function ( ) {

    // Every one of these is the name of the file that defines the plugin. The
    // registered name is shorter, so the entry matches nothing, and before this
    // warning existed it did so in complete silence.
    var fileNames = {
      cannulaage: 'cage'
      , insulinage: 'iage'
      , sensorage: 'sage'
      , batteryage: 'bage'
      , boluswizardpreview: 'bwp'
      , basalprofile: 'basal'
    };

    Object.keys(fileNames).forEach(function eachFileName (fileName) {
      it('warns that ' + fileName + ' is not a plugin name and names ' + fileNames[fileName], function ( ) {
        var result = registerWith([fileName], 'client');

        result.armed.should.eql([]);
        result.warnings.length.should.equal(1);
        result.warnings[0].should.match(new RegExp('"' + fileName + '"'));
        result.warnings[0].should.match(new RegExp('"' + fileNames[fileName] + '"'));
      });
    });

    it('names the nearest plugin for a misspelt entry', function ( ) {
      var result = registerWith(['ar3'], 'client');

      result.armed.should.eql([]);
      result.warnings.length.should.equal(1);
      result.warnings[0].should.match(/"ar2"/);
    });

    it('says nothing about an entry with no plausible plugin behind it', function ( ) {
      registerWith(['somethingnobodyshipped'], 'client').warnings.should.eql([]);
    });

    // A warning nobody can distinguish from noise is not a warning. These are
    // the features README documents for ENABLE, plus the defaults settings.js
    // adds; several are not plugins at all and several are registered on only
    // one side of the client/server split.
    var documented = ['delta', 'direction', 'upbat', 'timeago', 'devicestatus', 'errorcodes'
      , 'ar2', 'simplealarms', 'profile', 'careportal', 'boluscalc', 'food', 'rawbg', 'iob'
      , 'cob', 'bwp', 'cage', 'iage', 'bage', 'treatmentnotify', 'basal', 'bolus', 'connect'
      , 'bridge', 'mmconnect', 'pump', 'openaps', 'loop', 'override', 'xdripjs', 'alexa'
      , 'googlehome', 'speech', 'cors', 'dbsize', 'bgnow', 'runtimestate', 'pushover', 'maker'];

    ['client', 'server'].forEach(function eachMode (mode) {
      it('stays quiet about every documented ENABLE feature on the ' + mode, function ( ) {
        var result = registerWith(documented, mode);

        result.warnings.should.eql([]);
        // Non-vacuity: a run that armed nothing would also produce no warnings.
        result.armed.indexOf('cage').should.be.above(-1);
        result.armed.indexOf('iage').should.be.above(-1);
        result.armed.indexOf('bwp').should.be.above(-1);
      });
    });

    it('has an alias for every plugin whose file name is not its plugin name', function ( ) {
      var pluginsDir = path.resolve(__dirname, '../lib/plugins');
      var index = fs.readFileSync(path.join(pluginsDir, 'index.js'), 'utf8');
      var modules = {};

      index.replace(/re(?:quire|q)\('\.\/([a-z0-9]+)'\)\(ctx\)/g, function collect (match, name) {
        modules[name] = true;
        return match;
      });

      Object.keys(modules).length.should.be.above(20);

      var aliases = require('../lib/plugins/')({
        settings: { }
        , language: require('../lib/language')()
      }).moduleNameAliases;

      Object.keys(modules).forEach(function eachModule (moduleName) {
        var source = fs.readFileSync(path.join(pluginsDir, moduleName + '.js'), 'utf8');
        var declared = source.match(/name:\s*'([a-z0-9]+)'/);
        if (!declared || declared[1] === moduleName) return;
        aliases[moduleName].should.equal(declared[1]);
      });
    });

  });

  // isPluginEnabled compared find()'s result with null, but find() returns
  // undefined when nothing matches, so every name - enabled, disabled or made
  // up - came back as enabled.
  it('isPluginEnabled answers false for a plugin that is not enabled', function ( ) {
    var registered = registerWith(['careportal'], 'client');

    // Non-vacuity: careportal really is armed and cage really is not, so the
    // two answers below are about enablement and not about registration.
    registered.armed.should.containEql('careportal');
    registered.armed.should.not.containEql('cage');

    registered.plugins.isPluginEnabled('careportal').should.equal(true);
    registered.plugins.isPluginEnabled('cage').should.equal(false);
    registered.plugins.isPluginEnabled('no-such-plugin').should.equal(false);
  });

});
