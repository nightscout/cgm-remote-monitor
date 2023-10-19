
var read = require('fs').readFileSync;
var _ = require('lodash');

function headless (benv, binding) {
  var self = binding;
  function root ( ) {
    return benv;
  }

  function init (opts, callback) {

    var localStorage = opts.localStorage || './localstorage';
    const t = Date.now();

    console.log('Headless init');

    var htmlFile = opts.htmlFile || __dirname + '/../../views/index.html';
    var serverSettings = opts.serverSettings || require('./default-server-settings');
    var someData = opts.mockAjax || { };

    console.log('Entering setup', Date.now() - t);

    benv.setup(function() {

      console.log('Setting up benv', Date.now() - t);

      benv.require(__dirname + '/../../node_modules/.cache/_ns_cache/public/js/bundle.app.js');
      
      console.log('Bundle loaded', Date.now() - t);

      self.$ = $;
      
      self.localCookieStorage = self.localStorage = self.$.localStorage = require(localStorage);

      self.$.fn.tooltip = function mockTooltip ( ) { };

      var indexHtml = read(htmlFile, 'utf8');
      self.$('body').html(indexHtml);

      console.log('HTML set', Date.now() - t);

      var d3 = require('d3');
      //disable all d3 transitions so most of the other code can run with jsdom
      d3.timer = function mockTimer() { };
      
      if (opts.mockProfileEditor) {
        self.$.plot = function mockPlot () {
        };

        self.$.fn.tooltip = function mockTooltip ( ) { };

        self.$.fn.dialog = function mockDialog (opts) {
          function maybeCall (name, obj) {
            if (obj[name] && obj[name].call) {
              obj[name]();
            }

          }
          maybeCall('open', opts);

          _.forEach(opts.buttons, function (button) {
            maybeCall('click', button);
          });
        };
      }
      if (opts.mockSimpleAjax) {
        someData = opts.mockSimpleAjax;
        self.$.ajax = function mockAjax (url, opts) {
          if (url && url.url) {
            url = url.url;
          }

          var returnVal = someData[url] || [];
          if (opts && typeof opts.success === 'function') {
            opts.success(returnVal);
            return self.$.Deferred().resolveWith(returnVal);
          } else {
            return {
              done: function mockDone (fn) {
                if (url.indexOf('status.json') > -1) {
                  fn(serverSettings);
                } else {
                  fn({message: 'OK'});
                }
                return self.$.ajax();
              },
              fail: function mockFail () {
                return self.$.ajax();
              }
            };
          }
        };
      }
      if (opts.mockAjax) {
        self.$.ajax = function mockAjax (url, opts) {

          if (url && url.url) {
            url = url.url;
          }

          //logfile.write(url+'\n');
          //console.log(url,opts);
          if (opts && opts.success && opts.success.call) {
            return {
              done: function mockDone (fn) {
                  if (someData[url]) {
                    console.log('+++++Data for ' + url + ' sent');
                    opts.success(someData[url]);
                  } else {
                    console.log('-----Data for ' + url + ' missing');
                    opts.success([]);
                  }
                fn();
                return self.$.ajax();
              },
              fail: function mockFail () {
                return self.$.ajax();
              }
            };
          }
          return {
            done: function mockDone (fn) {
              if (url.indexOf('status.json') > -1) {
                fn(serverSettings);
              } else {
                fn({message: 'OK'});
              }
              return self.$.ajax();
              },
            fail: function mockFail () {
              return self.$.ajax();
              }
          };
        };
      }

      console.log('Benv expose', Date.now() - t);

      benv.expose({
        $: self.$
        , jQuery: self.$
        , d3: d3
        , serverSettings: serverSettings
        , localCookieStorage: self.localStorage
        , cookieStorageType: self.localStorage
		, localStorage: self.localStorage
        , io: {
          connect: function mockConnect ( ) {
            return {
              on: function mockOn (event, callback) {
                if ('connect' === event && callback) {
                  callback();
                }
              }
              , emit: function mockEmit (event, data, callback) {
                if ('authorize' === event && callback) {
                  callback({
                    read: true
                  });
                }
              }
            };
          }
        }
      });

      var extraRequires = opts.benvRequires || [ ];
      extraRequires.forEach(function (req) {
        benv.require(req);
      });
      callback( );
    });
    
  }

  function teardown ( ) {
    benv.teardown();
  }
  root.setup = init;
  root.teardown = teardown;

  return root;
}

module.exports = headless;
