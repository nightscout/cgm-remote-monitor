'use strict';

// #7377: on a site that denies anonymous reads, a viewer who opened the main
// page with ?token= and picked a view from the Clock menu got a blank clock.
// The menu links now carry the page's token, and a refused clock says so.

require('should');
var fs = require('fs');
var path = require('path');
var ejs = require('ejs');

var createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
var domGlobals = require('./fixtures/dom-globals');

var CLOCK_LINKS = ['bgclocklink', 'clockcolorlink', 'clocklink', 'clockconfiglink'];

function menuHtml () {
  // The Clock menu exactly as views/index.html serves it.
  var index = fs.readFileSync(path.join(__dirname, '../views/index.html'), 'utf8');
  var m = index.match(/<li class="multilink">[\s\S]*?<\/li>/);
  if (!m) { throw new Error('Clock menu not found in views/index.html'); }
  return m[0];
}

describe('clock menu links carry the page token (#7377)', function () {
  var env, state, $, browserSettings;

  function load (pageUrl) {
    env = createSecureDOM(
      '<!DOCTYPE html><html><body><ul>' + menuHtml() +
      '<li><a id="reportlink" href="report">Reports</a></li></ul></body></html>'
      , { url: 'http://localhost' + pageUrl }
    );
    state = domGlobals.installDomGlobals(env);
    domGlobals.defineConfigurable(global, 'location', env.window.location);
    $ = env.window.$;
    $.fn.tooltip = function () { return this; }; // jquery-ui is not loaded here
    delete require.cache[require.resolve('../lib/client/browser-settings')];
    delete require.cache[require.resolve('../lib/client/browser-utils')];
    browserSettings = require('../lib/client/browser-settings');

    function translate (text) { return text; }
    var client = {
      browserUtils: require('../lib/client/browser-utils')($)
      , language: { languages: [], translate: translate }
      , plugins: { specialPlugins: [], eachEnabledPlugin: function () {} }
      , translate: translate
      , utils: { scaleMgdl: function (value) { return value; } }
    };
    var serverSettings = { settings: { enable: '', showPlugins: '', units: 'mg/dl'
      , thresholds: { bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 } }
      , extendedSettings: {} };
    client.settings = browserSettings(client, serverSettings, $);
    browserSettings.loadAndWireForm();
  }

  function hrefs () {
    return CLOCK_LINKS.map(function (id) { return $('#' + id).attr('href'); });
  }

  afterEach(function () {
    delete require.cache[require.resolve('../lib/client/browser-settings')];
    delete require.cache[require.resolve('../lib/client/browser-utils')];
    delete global.location;
    domGlobals.restoreDomGlobals(state);
    env.cleanup();
  });

  it('adds the token to every clock link when the page was opened with one', function () {
    load('/?token=mom_phone-0123456789abcdef');
    hrefs().should.deepEqual([
      '/clock/bgclock?token=mom_phone-0123456789abcdef'
      , '/clock/clock-color?token=mom_phone-0123456789abcdef'
      , '/clock/clock?token=mom_phone-0123456789abcdef'
      , '/clock/config?token=mom_phone-0123456789abcdef'
    ]);
  });

  it('URL-encodes the token, once', function () {
    load('/?token=a:b/c?d-0123456789abcdef');
    $('#clockcolorlink').attr('href').should.equal('/clock/clock-color?token=a%3Ab%2Fc%3Fd-0123456789abcdef');
  });

  it('does not encode an already-encoded token twice', function () {
    load('/?token=a%20b%26c-0123456789abcdef');
    $('#clockcolorlink').attr('href').should.equal('/clock/clock-color?token=a%20b%26c-0123456789abcdef');
  });

  it('adds nothing when the page address has no token', function () {
    load('/');
    hrefs().should.deepEqual(['/clock/bgclock', '/clock/clock-color', '/clock/clock', '/clock/config']);
    $('#reportlink').attr('href').should.equal('report');
  });
});

describe('clock says when it is refused (#7377)', function () {

  describe('the properties fetch', function () {
    var benv = require('./fixtures/benv-loader');
    var clockClient;

    beforeEach(function (done) {
      benv.setup(function () {
        global.$ = require('jquery');
        global.localStorage = { getItem: function () { return null; } };
        global.$('body').html('<main><div id="inner" data-face="bn0-sg40"></div></main>');
        delete require.cache[require.resolve('../lib/client/clock-client')];
        clockClient = require('../lib/client/clock-client');
        done();
      });
    });

    afterEach(function (done) {
      delete require.cache[require.resolve('../lib/client/clock-client')];
      delete global.$;
      delete global.localStorage;
      benv.teardown(true);
      done();
    });

    function query (status) {
      global.$.ajax = function (url, opts) { opts.error({ status: status, statusText: 'x' }); };
      var origErr = console.error; console.error = function () {};
      try { clockClient.query(); } finally { console.error = origErr; }
    }

    it('shows the message on a 401', function () {
      query(401);
      global.$('#authMessage').text().should.match(/^Not authorized: open this clock with a token/);
    });

    it('shows nothing new on other failures', function () {
      query(500);
      global.$('#authMessage').length.should.equal(0);
    });
  });

  describe('the status script', function () {
    function renderClock (face) {
      var file = path.join(__dirname, '../views/clockviews/clock.html');
      return ejs.render(fs.readFileSync(file, 'utf8'), { face: face, locals: { bundle: '/bundle' } }, { filename: file });
    }

    function boot (statusCode) {
      var calls = { shown: 0, init: 0, asked: [] };
      return new Promise(function (resolve) {
        var env = createSecureDOM(renderClock('clock-color'), {
          url: 'http://localhost/clock/clock-color'
          , runScripts: 'dangerously'
          // Quiet: the refused script loads below are the point of the test.
          , virtualConsole: new (require('jsdom').VirtualConsole)()
          , beforeParse: function (window) {
            // The clock bundle is not served here; stand in for the two
            // things the page uses from it. The secure loader refuses every
            // script load, which is what a browser does with a 401 script.
            window.$ = { ajax: function (url, opts) {
              calls.asked.push(url);
              setTimeout(function () { opts.error({ status: statusCode }); }, 0);
            } };
            window.Nightscout = { client: {
              init: function () { calls.init++; }
              , showNotAuthorized: function () { calls.shown++; }
            } };
          }
        });
        setTimeout(function () { env.cleanup(); resolve(calls); }, 200);
      });
    }

    it('shows the message when the status script is refused with 401', async function () {
      var calls = await boot(401);
      calls.init.should.equal(0);
      calls.asked.length.should.equal(1);
      calls.asked[0].should.match(/^\/api\/v1\/status\.js\?t=\d+$/);
      calls.shown.should.equal(1);
    });

    it('shows nothing when the failure is not a 401', async function () {
      var calls = await boot(503);
      calls.asked.length.should.equal(1);
      calls.shown.should.equal(0);
    });
  });
});

describe('clock configurator link keeps the token, encoded (#7377)', function () {
  function renderConfig () {
    var file = path.join(__dirname, '../views/clockviews/clock.html');
    return ejs.render(fs.readFileSync(file, 'utf8'), { face: 'config', locals: { bundle: '/bundle' } }, { filename: file });
  }

  function boot (search) {
    // The clock bundle is not served here: in its place, give the page jQuery
    // and a client that does nothing.
    var stand = '<script>' + fs.readFileSync(require.resolve('jquery/dist/jquery.js'), 'utf8') + '</script>' +
      '<script>window.Nightscout = { client: { init: function () {}, query: function () {}, showNotAuthorized: function () {} } };</script>';
    var html = renderConfig().replace(/<script src="[^"]*bundle\.clock\.js"><\/script>/, function () { return stand; });
    html.should.not.match(/bundle\.clock\.js/);
    return new Promise(function (resolve) {
      var env = createSecureDOM(html, {
        url: 'http://localhost/clock/config' + search
        , runScripts: 'dangerously'
        , virtualConsole: new (require('jsdom').VirtualConsole)()
      });
      setTimeout(function () { resolve(env); }, 100);
    });
  }

  it('carries the page token on the link to the configured clock', async function () {
    var env = await boot('?token=reader-0123456789abcdef');
    var $ = env.window.$;
    $('#clocklink').attr('href').should.equal('/clock/cy10?token=reader-0123456789abcdef');
    $('#facename').text('cy10-sg40');
    $('#facename').change();
    $('#clocklink').attr('href').should.equal('/clock/cy10-sg40?token=reader-0123456789abcdef');
    env.cleanup();
  });

  it('encodes the token and the face, so neither can change the link', async function () {
    var env = await boot('?token=' + encodeURIComponent('a"b<c d'));
    var $ = env.window.$;
    $('#clocklink').attr('href').should.equal('/clock/cy10?token=a%22b%3Cc%20d');
    $('#facename').text('cy10?x=1#y');
    $('#facename').change();
    $('#clocklink').attr('href').should.equal('/clock/cy10%3Fx%3D1%23y?token=a%22b%3Cc%20d');
    env.cleanup();
  });

  it('adds nothing when the page has no token', async function () {
    var env = await boot('');
    env.window.$('#clocklink').attr('href').should.equal('/clock/cy10');
    env.cleanup();
  });
});
