'use strict';

require('should');
var _ = require('lodash');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

var nowData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
};

var someData = {
  '/api/v1/devicestatus.json?count=500': [
    {
    '_id': {
        '$oid': '56096da3c5d0fef41b212362'
    },
    'uploaderBattery': 37,
    'created_at': '2015-09-28T16:41:07.144Z'
    },
    {
    '_id': {
        '$oid': '56096da3c5d0fef41b212363'
    },
    'uploaderBattery': 38,
    'created_at': '2025-09-28T16:41:07.144Z'
    }
  ],
  '/api/v1/treatments.json?&find[created_at][$gte]=': [
      {
        '_id':  '5609a9203c8104a8195b1c1e',
        'enteredBy': '',
        'eventType': 'Carb Correction',
        'carbs': 3,
        'created_at': '2025-09-28T20:54:00.000Z'
      }
    ],
  '/api/v1/entries.json?&find[date][$gte]=': [
      {
        '_id': '560983f326c5a592d9b9ae0c',
        'device': 'dexcom',
        'date': 1543464149000,
        'sgv': 83,
        'direction': 'Flat',
        'type': 'sgv',
        'filtered': 107632,
        'unfiltered': 106256,
        'rssi': 178,
        'noise': 1
      }
    ]
  };


describe('admintools', function ( ) {
  var self = this;

  before(function (done) {
    benv.setup(function() {
      self.$ = require('jquery');
      self.$.localStorage = require('./fixtures/localstorage');

      self.$.fn.tipsy = function mockTipsy ( ) { };

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

      var indexHtml = read(__dirname + '/../static/admin/index.html', 'utf8');
      self.$('body').html(indexHtml);

      //var filesys = require('fs');
      //var logfile = filesys.createWriteStream('out.txt', { flags: 'a'} )
      
      self.$.ajax = function mockAjax (url, opts) {
        if (url && url.url) {
          url = url.url;
        }
        //logfile.write(url+'\n');
        //console.log(url,opts);
        if (opts && opts.success && opts.success.call) {
          if (url.indexOf('/api/v1/treatments.json?&find[created_at][$gte]=')===0) {
            url = '/api/v1/treatments.json?&find[created_at][$gte]=';
          }
          if (url.indexOf('/api/v1/entries.json?&find[date][$gte]=')===0) {
            url = '/api/v1/entries.json?&find[date][$gte]=';
          }
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

      self.$.plot = function mockPlot () {
      };

      var d3 = require('d3');
      //disable all d3 transitions so most of the other code can run with jsdom
      d3.timer = function mockTimer() { };

      benv.expose({
        $: self.$
        , jQuery: self.$
        , d3: d3
        , serverSettings: serverSettings
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

      benv.require(__dirname + '/../bundle/bundle.source.js');
      benv.require(__dirname + '/../static/admin/js/admin.js');

      done();
    });
  });

  after(function (done) {
    benv.teardown(true);
    done();
  });

  it ('should produce some html', function (done) {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');

    var hashauth = require('../lib/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

     window.confirm = function mockConfirm (text) {
       console.log('Confirm:', text);
       return true;
     };

     window.alert = function mockAlert () {
       return true;
     };

    client.init(plugins);
    client.dataUpdate(nowData);
    
    //var result = $('body').html();
    //var filesys = require('fs');
    //var logfile = filesys.createWriteStream('out.txt', { flags: 'a'} )
    //logfile.write($('body').html());
    
    //console.log(result);

    $('#admin_cleanstatusdb_0_html + button').text().should.equal('Delete all documents'); // devicestatus button
    $('#admin_cleanstatusdb_0_status').text().should.equal('Database contains 2 records'); // devicestatus init result
    
    $('#admin_cleanstatusdb_0_html + button').click();
    $('#admin_cleanstatusdb_0_status').text().should.equal('All records removed ...'); // devicestatus code result

    $('#admin_futureitems_0_html + button').text().should.equal('Remove treatments in the future'); // futureitems button 0
    $('#admin_futureitems_0_status').text().should.equal('Database contains 1 future records'); // futureitems init result 0
    
    $('#admin_futureitems_0_html + button').click();
    $('#admin_futureitems_0_status').text().should.equal('Record 5609a9203c8104a8195b1c1e removed ...'); // futureitems code result 0

    $('#admin_futureitems_1_html + button').text().should.equal('Remove entries in the future'); // futureitems button 1
    $('#admin_futureitems_1_status').text().should.equal('Database contains 1 future records'); // futureitems init result 1
    
    $('#admin_futureitems_1_html + button').click();
    $('#admin_futureitems_1_status').text().should.equal('Record 560983f326c5a592d9b9ae0c removed ...'); // futureitems code result 1

    done();
  });

});
