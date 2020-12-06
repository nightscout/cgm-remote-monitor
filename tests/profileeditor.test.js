'use strict';

require('should');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

var nowData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
  , treatments: []
};


var exampleProfile = {
  //General values
  'dia':3,

  // Simple style values, 'from' are in minutes from midnight
  'carbratio': [
    {
      'time': '00:00',
      'value': 30
    }],
  'carbs_hr':30,
  'delay': 20,
  'sens': [
    {
      'time': '00:00',
      'value': 100
    }
    , {
      'time': '8:00',
      'value': 80
    }],
  'startDate': new Date(),
  'timezone': 'UTC',

  //perGIvalues style values
  'perGIvalues': false,
  'carbs_hr_high': 30,
  'carbs_hr_medium': 30,
  'carbs_hr_low': 30,
  'delay_high': 15,
  'delay_medium': 20,
  'delay_low': 20,

  'basal':[
    {
      'time': '00:00',
      'value': 0.1
    }],
  'target_low':[
    {
      'time': '00:00',
      'value': 0
    }],
  'target_high':[
    {
      'time': '00:00',
      'value': 0
    }]
};
exampleProfile.startDate.setSeconds(0);
exampleProfile.startDate.setMilliseconds(0);


describe('profile editor', function ( ) {
  var self = this;

  before(function (done) {
    benv.setup(function() {
      self.$ = require('jquery');
      self.$.localStorage = require('./fixtures/localstorage');

      self.$.fn.tipsy = function mockTipsy ( ) { };

      var indexHtml = read(__dirname + '/../static/profile/index.html', 'utf8');
      self.$('body').html(indexHtml);

      self.$.ajax = function mockAjax (url, opts) {
        return {
          done: function mockDone (fn) {
            if (opts && opts.success && opts.success.call) {
              opts.success([exampleProfile]);
            }
            fn();
            return {
              fail: function () {}
            };
          }
        };
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
              on: function mockOn ( ) { }
            };
          }
        }
      });

      benv.require(__dirname + '/../bundle/bundle.source.js');
      benv.require(__dirname + '/../static/profile/js/profileeditor.js');

      done();
    });
  });

  after(function (done) {
    benv.teardown(true);
    done();
  });

  it ('don\'t blow up', function (done) {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');

    var hashauth = require('../lib/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };


    client.init(serverSettings, plugins);
    client.dataUpdate(nowData);

    $('#pe_form').find('button').click();

    done();
  });

});
