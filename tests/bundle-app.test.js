
'use strict';

require('should');

// var sinon = require('sinon');
// var nise = require('nise');
var jsdom = require('jsdom');
var urllib = require('url');
var path = require('path');
var vm = require('vm');

var setupDom = require('global-jsdom');

var cachePrefix = path.resolve(path.join(__dirname, '../', './node_modules/.cache/_ns_cache/public/'));
// var statsInfo = require('.cache/_ns_cache/public/stats.json');

var readFile = require('fs').promises.readFile;
function loadAsset (url) {
  var parsed = urllib.parse(url);
  var filepath = path.join(cachePrefix, parsed.pathname);
  console.log('loading', { filepath, url });
  return readFile(filepath);
}

class CustomResourceLoader extends jsdom.ResourceLoader {
  fetch(url, options) {
    
    // console.log("IS BUNDLE?", url.indexOf('file:///bundle/js/'), options);
    var parsed = urllib.parse(url);
    console.log('loading', parsed);
    if (0 == parsed.pathname.indexOf('/bundle/js/')) {
      // return loadAsset(url);

      console.log("IS BUNDLE changing url", url, parsed);
      var new_url = String(urllib.pathToFileURL(path.join(cachePrefix, parsed.pathname.replace(/^[/]bundle/, ''))));
      // console.log("new url, loading super", new_url, url);
      return super.fetch(new_url, options);
    }

    return super.fetch(url, options);
  }
}

describe('hashauth with jsdom experiments', function ( ) {

  before(function (done) {
    var self = this;
    done( );
  });

  after(function (done) {
    return done( );
  });


  // hello world test
  it ('should construct jsdom for a bundled entrypoint', async function ( ) {

    var serverSettings = require('./fixtures/default-server-settings');
    var virtualConsole = new jsdom.VirtualConsole();
    virtualConsole.sendTo(console);
    var htmlFile = path.join(cachePrefix, 'test-test-bundle.html');
    var someData = { };
    console.log('fetching html');
    /*
    */
    var html = await readFile(htmlFile);
    console.log('setting up dom');
    var cleanup = setupDom(html, {
      // this causes actual ajax/websocket requests to be sent
      url: 'http://localhost:3030',
      runScripts: 'dangerously',
      // this allows controlling hypermedia assets loaded via script/style/img tags
      resources: new CustomResourceLoader(),
      beforeParse: function (window) {

      },
      virtualConsole
      
    });

    // window.eval('console.log("inner sinon", sinon); window.server = sinon.fakeServer.create( );');
    // this.xhr = nise.fakeXhr.fakeXMLHttpRequestFor(window);
    // console.log(this.xhr);
    // var xhr = this.xhr.useFakeXMLHttpRequest( );
    // var xhr = window.sinon.useFakeXMLHttpRequest( );
    /*
    */

    // inject some arbitrary fixture code
    var scriptEl = window.document.createElement('script');
    scriptEl.textContent = `
    // TODO: rename inject/setup/teardown
    window.inspect = (function inspect ( )  {
    console.log("from inside!!");
    // window.xhr = sinon.useFakeXMLHttpRequest( );
    // removing use of sinon shows spamming non-existent server network requests
    window.server = sinon.useFakeServer( );
        window.server.autoRespond = true;
        window.server.autoRespondAfter = 10;
    var _onCreate = window.XMLHttpRequest.onCreate;
    // window.xhr = window.server.useFakeXMLHttpRequest( );

        // these are never called
        // window.server.respondWith(/.*/,
          // [ 200, { 'content-type': 'application/json' },
          // JSON.stringify({ })]);
        window.server.respondWith(/not.*/, function catchall (xhr) {
          console.log('REQ!', xhr.url, xhr);
          xhr.respond(200, { 'content-type': 'application/json' },
          JSON.stringify({caught: 'fakeserver' }));
        });

        window.server.xhr.onCreate = function (req) {

          // url is always undefined!?
          console.log("onCreate 1", req.url, req, window.server.requests.length, window.server.requestCount);
          _onCreate.apply(this, arguments);
          if (window.server.requests.length) {
            console.log('many requests pending', window.server.requests.length, window.server.requests[0]);

            // window.server.requests[0].respond(200, { }, JSON.stringify({catchall: 2 }));
            // window.server.respond( );
          }
          console.log("onCreate 2", req.url, req, window.server.requests.length, window.server.requestCount);
          req.addEventListener('loadstart', function () {
            console.log("LOADSTART REQ", arguments, req);
          });
          req.addEventListener('error', function () {
            console.log("ERROR REQ", arguments, req);
          });
          req.addEventListener('abort', function () {
            console.log("ABORT REQ", arguments, req);
          });
          return 
        }
        window.server.respondWith(/([/]api[/]v1[/]status[.]json)/, function statusjson (xhr) {
          console.log('REQ/RES!', xhr.url, xhr);
          xhr.respond(200, { 'content-type': 'application/json' },
          JSON.stringify(${JSON.stringify(serverSettings)}));
        });
        
        // window.server.respond( );
    });
    `;
    /*
    */
    window.document.body.appendChild(scriptEl);


    var self = this;
    var step = new Promise(function (resolve) {
      // console.log('window', window);
      window.addEventListener('load', function ( ) {
        window.inspect();
        console.log('testing loaded window', window.Nightscout);

        // console.log('appended', window.server);


        // var server = window.server;
        // server.configure( { autoRespond: true } );
        // server.respondWith(/.*/, function (xhr) {
        // console.log('REQ!', xhr);
        // xhr.respond(200, { 'content-type': 'application/json' },
        // { });
      // });

        // server.respond( );
        // removing call to init allows test to finish
        // window.Nightscout.client.init();
        window.eval(`
        console.log('inside, initing NS client');
        
        // 
        // window.Nightscout.client.init();
        // window.Nightscout.client.init(function ( ) {
        //   console.log('NS client inited', window.Nightscout);
        //   window.NS_TEST_INIT = true;
        // });
        /*
        */
        // never reaches after init
        console.log('inside after call to init');
        `);
        // never reaches after init, inside or outside jsdom's vm.
        const scriptedStart = new vm.Script(`
          console.log('running inint from internal vm');
          window.Nightscout.client.init(function ( ) {
            console.log('NS client inited', window.Nightscout);
            window.NS_TEST_INIT = true;
            $(window.document).trigger('loaded_nightscout', [Nightscout.client ]);
          });
          console.log('attempting and waiting init from internal vm');
        `);
        const vmContext = $jsdom.getInternalVMContext( );
        window.$(window.document).on('loaded_nightscout', function (ev, client) {

          console.log.bind(console, 'inited', arguments)();
          return resolve( );
        });
        scriptedStart.runInContext(vmContext);
        console.log('after call to init', window.server.requests);
        // window.server.respond( );
        // window.Nightscout.client.init(function ( ) { console.log.bind(console, 'init', arguments)(); return resolve( ); });
        console.log('after after call to init');
        // return;
        // 
        var src = '/api/v1/status.json?manual=true&t=' + new Date().getTime();
        window.$.ajax({url: src, method: 'GET'}).done(function (ev) {
          console.log.bind(console, 'ajaxed', arguments)();
          return resolve( );
        }).fail(function ( ) {
          console.log.bind(console, 'ajaxed fail', arguments)();
          return resolve( );

        });
        console.log('after call to ajax', window.server);
        // window.server.respond( );


      });
    });
    return step;

    /*
    var loader = jsdom.JSDOM.fromFile(htmlFile, {
      runScripts: 'dangerously',
      resources: new CustomResourceLoader(),
      virtualConsole
      
    }).then(function (dom) {
      console.log('succeeded loading jsdom', dom.window.Nightscout);
      var xhr = dom.window.sinon.useFakeXMLHttpRequest( );
      xhr.onCreate(function (req) {
        console.log("!!", req, this, xhr);
      });

      // dom.window.Nightscout.client.init();
      // var hashauth = dom.window.Nightscout.client.hashauth.init(dom.window.Nightscout.client, dom.window.$);
      // console.log('succeeded loading hashauth', hashauth);
      dom.window.Nightscout.client.init(function ( ) {
        console.log('NS client inited', window.Nightscout);
        return done( );
      });
      // return done( );
      // dom.window.Nightscout.client.init( );
    });
    */

  });

});
