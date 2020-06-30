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
  , treatments: []
};

var someData = {
  '/api/v1/entries.json?find[date][$gte]=1438992000000&find[date][$lt]=1439078400000&count=10000': [{'_id':'55c697f9459cf1fa5ed71cd8','unfiltered':213888,'filtered':218560,'direction':'Flat','device':'dexcom','rssi':172,'sgv':208,'dateString':'Sat Aug 08 16:58:44 PDT 2015','type':'sgv','date':1439078324000,'noise':1},{'_id':'55c696cc459cf1fa5ed71cd7','unfiltered':217952,'filtered':220864,'direction':'Flat','device':'dexcom','rssi':430,'sgv':212,'dateString':'Sat Aug 08 16:53:45 PDT 2015','type':'sgv','date':1439078025000,'noise':1},{'_id':'55c5d0c6459cf1fa5ed71a04','device':'dexcom','scale':1.1,'dateString':'Sat Aug 08 02:48:05 PDT 2015','date':1439027285000,'type':'cal','intercept':31102.323470336833,'slope':776.9097574914869},{'_id':'55c5d0c5459cf1fa5ed71a03','device':'dexcom','dateString':'Sat Aug 08 02:48:03 PDT 2015','mbg':120,'date':1439027283000,'type':'mbg'}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-08-09T00:00:00.000Z': [{'enteredBy':'Dad','eventType':'Correction Bolus','glucose':201,'glucoseType':'Finger','insulin':0.65,'units':'mg/dl','created_at':'2015-08-08T23:22:00.000Z','_id':'55c695628a00a3c97a6611ed'},{'enteredBy':'Mom ','eventType':'Correction Bolus','glucose':163,'glucoseType':'Sensor','insulin':0.7,'units':'mg/dl','created_at':'2015-08-08T22:53:11.021Z','_id':'55c68857cd6dd2036036705f'}],
  '/api/v1/entries.json?find[date][$gte]=1439078400000&find[date][$lt]=1439164800000&count=10000': [{'_id':'55c7e85f459cf1fa5ed71dc8','unfiltered':183520,'filtered':193120,'direction':'NOT COMPUTABLE','device':'dexcom','rssi':161,'sgv':149,'dateString':'Sun Aug 09 16:53:40 PDT 2015','type':'sgv','date':1439164420000,'noise':1},{'_id':'55c7e270459cf1fa5ed71dc7','unfiltered':199328,'filtered':192608,'direction':'Flat','device':'dexcom','rssi':161,'sgv':166,'dateString':'Sun Aug 09 16:28:40 PDT 2015','type':'sgv','date':1439162920000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-09T00:00:00.000Z&find[created_at][$lt]=2015-08-10T00:00:00.000Z': [{'enteredBy':'Dad','eventType':'Snack Bolus','carbs':18,'insulin':1.1,'created_at':'2015-08-09T22:41:56.253Z','_id':'55c7d734270fbd97191013c2'},{'enteredBy':'Dad','eventType':'Carb Correction','carbs':5,'created_at':'2015-08-09T21:39:13.995Z','_id':'55c7c881270fbd97191013b4'}],
  '/api/v1/entries.json?find[date][$gte]=1439164800000&find[date][$lt]=1439251200000&count=10000': [{'_id':'55c93af4459cf1fa5ed71ecc','unfiltered':193248,'filtered':188384,'direction':'NOT COMPUTABLE','device':'dexcom','rssi':194,'sgv':193,'dateString':'Mon Aug 10 16:58:36 PDT 2015','type':'sgv','date':1439251116000,'noise':1},{'_id':'55c939d8459cf1fa5ed71ecb','unfiltered':189888,'filtered':184960,'direction':'NOT COMPUTABLE','device':'dexcom','rssi':931,'sgv':188,'dateString':'Mon Aug 10 16:53:38 PDT 2015','type':'sgv','date':1439250818000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-10T00:00:00.000Z&find[created_at][$lt]=2015-08-11T00:00:00.000Z': [{'enteredBy':'Mom ','eventType':'Snack Bolus','glucose':180,'glucoseType':'Sensor','carbs':18,'insulin':1.9,'units':'mg/dl','created_at':'2015-08-10T23:53:31.970Z','_id':'55c9397b865550df020e3560'},{'enteredBy':'Mom ','eventType':'Meal Bolus','glucose':140,'glucoseType':'Finger','carbs':50,'insulin':3.4,'units':'mg/dl','created_at':'2015-08-10T20:41:23.516Z','_id':'55c90c73865550df020e3539'}],
  '/api/v1/entries.json?find[date][$gte]=1439251200000&find[date][$lt]=1439337600000&count=10000': [{'_id':'55ca8c6e459cf1fa5ed71fe2','unfiltered':174080,'filtered':184576,'direction':'FortyFiveDown','device':'dexcom','rssi':169,'sgv':156,'dateString':'Tue Aug 11 16:58:32 PDT 2015','type':'sgv','date':1439337512000,'noise':1},{'_id':'55ca8b42459cf1fa5ed71fe1','unfiltered':180192,'filtered':192768,'direction':'FortyFiveDown','device':'dexcom','rssi':182,'sgv':163,'dateString':'Tue Aug 11 16:53:32 PDT 2015','type':'sgv','date':1439337212000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-11T00:00:00.000Z&find[created_at][$lt]=2015-08-12T00:00:00.000Z': [{'created_at':'2015-08-11T23:37:00.000Z','eventType':'Snack Bolus','carbs':18,'_id':'55ca8644ca3c57683d19c211'},{'enteredBy':'Mom ','eventType':'Snack Bolus','glucose':203,'glucoseType':'Sensor','insulin':1,'preBolus':15,'units':'mg/dl','created_at':'2015-08-11T23:22:00.000Z','_id':'55ca8644ca3c57683d19c210'}],
  '/api/v1/entries.json?find[date][$gte]=1439337600000&find[date][$lt]=1439424000000&count=10000': [{'_id':'55cbddee38a8d88ad1b48647','unfiltered':165760,'filtered':167488,'direction':'Flat','device':'dexcom','rssi':165,'sgv':157,'dateString':'Wed Aug 12 16:58:28 PDT 2015','type':'sgv','date':1439423908000,'noise':1},{'_id':'55cbdccc38a8d88ad1b48644','unfiltered':167456,'filtered':169312,'direction':'Flat','device':'dexcom','rssi':168,'sgv':159,'dateString':'Wed Aug 12 16:53:28 PDT 2015','type':'sgv','date':1439423608000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-12T00:00:00.000Z&find[created_at][$lt]=2015-08-13T00:00:00.000Z': [{'enteredBy':'Dad','eventType':'Correction Bolus','insulin':0.8,'created_at':'2015-08-12T23:21:08.907Z','_id':'55cbd4e47e726599048a3f91'},{'enteredBy':'Dad','eventType':'Note','notes':'Milk now','created_at':'2015-08-12T21:23:00.000Z','_id':'55cbba4e7e726599048a3f79'}],
  '/api/v1/entries.json?find[date][$gte]=1439424000000&find[date][$lt]=1439510400000&count=10000': [{'_id':'55cd2f6738a8d88ad1b48ca1','unfiltered':209792,'filtered':229344,'direction':'SingleDown','device':'dexcom','rssi':436,'sgv':205,'dateString':'Thu Aug 13 16:58:24 PDT 2015','type':'sgv','date':1439510304000,'noise':1},{'_id':'55cd2e3b38a8d88ad1b48c95','unfiltered':220928,'filtered':237472,'direction':'FortyFiveDown','device':'dexcom','rssi':418,'sgv':219,'dateString':'Thu Aug 13 16:53:24 PDT 2015','type':'sgv','date':1439510004000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-13T00:00:00.000Z&find[created_at][$lt]=2015-08-14T00:00:00.000Z': [{'enteredBy':'Mom ','eventType':'Correction Bolus','glucose':250,'glucoseType':'Sensor','insulin':0.75,'units':'mg/dl','created_at':'2015-08-13T23:45:56.927Z','_id':'55cd2c3497fa97ac5d8bc53b'},{'enteredBy':'Mom ','eventType':'Correction Bolus','glucose':198,'glucoseType':'Sensor','insulin':1.1,'units':'mg/dl','created_at':'2015-08-13T23:11:00.293Z','_id':'55cd240497fa97ac5d8bc535'}],
  '/api/v1/entries.json?find[date][$gte]=1439510400000&find[date][$lt]=1439596800000&count=10000': [{'_id':'55ce80e338a8d88ad1b49397','unfiltered':179936,'filtered':202080,'direction':'SingleDown','device':'dexcom','rssi':179,'sgv':182,'dateString':'Fri Aug 14 16:58:20 PDT 2015','type':'sgv','date':1439596700000,'noise':1},{'_id':'55ce7fb738a8d88ad1b4938d','unfiltered':192288,'filtered':213792,'direction':'SingleDown','device':'dexcom','rssi':180,'sgv':197,'dateString':'Fri Aug 14 16:53:20 PDT 2015','type':'sgv','date':1439596400000,'noise':1}],
  '/api/v1/treatments.json?find[created_at][$gte]=2015-08-14T00:00:00.000Z&find[created_at][$lt]=2015-08-15T00:00:00.000Z': [{'enteredBy':'Dad','eventType':'Site Change','glucose':268,'glucoseType':'Finger','insulin':1.75,'units':'mg/dl','created_at':'2015-08-14T00:00:00.000Z','_id':'55ce78fe925aa80e7071e5d6'},{'enteredBy':'Mom ','eventType':'Meal Bolus','glucose':89,'glucoseType':'Finger','carbs':54,'insulin':3.15,'units':'mg/dl','created_at':'2015-08-14T21:00:00.000Z','_id':'55ce59bb925aa80e7071e5ba'}],
  '/api/v1/entries.json?find[date][$gte]=1439596800000&find[date][$lt]=1439683200000&count=10000': [{'_id':'55cfd25f38a8d88ad1b49931','unfiltered':283136,'filtered':304768,'direction':'SingleDown','device':'dexcom','rssi':185,'sgv':306,'dateString':'Sat Aug 15 16:58:16 PDT 2015','type':'sgv','date':1439683096000,'noise':1},{'_id':'55cfd13338a8d88ad1b4992e','unfiltered':302528,'filtered':312576,'direction':'FortyFiveDown','device':'dexcom','rssi':179,'sgv':329,'dateString':'Sat Aug 15 16:53:16 PDT 2015','type':'sgv','date':1439682796000,'noise':1}],
  '/api/v1/food/regular.json':  [{'_id':'552ece84a6947ea011db35bb','type':'food','category':'Zakladni','subcategory':'Sladkosti','name':'Bebe male','portion':18,'carbs':12,'gi':1,'unit':'pcs','created_at':'2015-04-15T20:48:04.966Z'}],
  '/api/v1/treatments.json?find[eventType]=/BG Check/i&find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-09-07T23:59:59.000Z': [
      {'created_at':'2015-08-08T00:00:00.000Z'},
      {'created_at':'2015-08-09T00:00:00.000Z'},
      {'created_at':'2015-08-10T00:00:00.000Z'},
      {'created_at':'2015-08-11T00:00:00.000Z'},
      {'created_at':'2015-08-12T00:00:00.000Z'},
      {'created_at':'2015-08-13T00:00:00.000Z'},
      {'created_at':'2015-08-14T00:00:00.000Z'},
      {'created_at':'2015-08-15T00:00:00.000Z'},
      {'created_at':'2015-08-16T00:00:00.000Z'},
      {'created_at':'2015-08-17T00:00:00.000Z'},
      {'created_at':'2015-08-18T00:00:00.000Z'},
      {'created_at':'2015-08-19T00:00:00.000Z'},
      {'created_at':'2015-08-20T00:00:00.000Z'},
      {'created_at':'2015-08-21T00:00:00.000Z'},
      {'created_at':'2015-08-22T00:00:00.000Z'},
      {'created_at':'2015-08-23T00:00:00.000Z'},
      {'created_at':'2015-08-24T00:00:00.000Z'},
      {'created_at':'2015-08-25T00:00:00.000Z'},
      {'created_at':'2015-08-26T00:00:00.000Z'},
      {'created_at':'2015-08-27T00:00:00.000Z'},
      {'created_at':'2015-08-28T00:00:00.000Z'},
      {'created_at':'2015-08-29T00:00:00.000Z'},
      {'created_at':'2015-08-30T00:00:00.000Z'},
      {'created_at':'2015-08-31T00:00:00.000Z'},
      {'created_at':'2015-09-01T00:00:00.000Z'},
      {'created_at':'2015-09-02T00:00:00.000Z'},
      {'created_at':'2015-09-03T00:00:00.000Z'},
      {'created_at':'2015-09-04T00:00:00.000Z'},
      {'created_at':'2015-09-05T00:00:00.000Z'},
      {'created_at':'2015-09-06T00:00:00.000Z'},
      {'created_at':'2015-09-07T00:00:00.000Z'}
    ],
  '/api/v1/treatments.json?find[notes]=/something/i&find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-09-07T23:59:59.000Z': [
      {'created_at':'2015-08-08T00:00:00.000Z'},
      {'created_at':'2015-08-09T00:00:00.000Z'},
      {'created_at':'2015-08-10T00:00:00.000Z'},
      {'created_at':'2015-08-11T00:00:00.000Z'},
      {'created_at':'2015-08-12T00:00:00.000Z'},
      {'created_at':'2015-08-13T00:00:00.000Z'},
      {'created_at':'2015-08-14T00:00:00.000Z'},
      {'created_at':'2015-08-15T00:00:00.000Z'},
      {'created_at':'2015-08-16T00:00:00.000Z'},
      {'created_at':'2015-08-17T00:00:00.000Z'},
      {'created_at':'2015-08-18T00:00:00.000Z'},
      {'created_at':'2015-08-19T00:00:00.000Z'},
      {'created_at':'2015-08-20T00:00:00.000Z'},
      {'created_at':'2015-08-21T00:00:00.000Z'},
      {'created_at':'2015-08-22T00:00:00.000Z'},
      {'created_at':'2015-08-23T00:00:00.000Z'},
      {'created_at':'2015-08-24T00:00:00.000Z'},
      {'created_at':'2015-08-25T00:00:00.000Z'},
      {'created_at':'2015-08-26T00:00:00.000Z'},
      {'created_at':'2015-08-27T00:00:00.000Z'},
      {'created_at':'2015-08-28T00:00:00.000Z'},
      {'created_at':'2015-08-29T00:00:00.000Z'},
      {'created_at':'2015-08-30T00:00:00.000Z'},
      {'created_at':'2015-08-31T00:00:00.000Z'},
      {'created_at':'2015-09-01T00:00:00.000Z'},
      {'created_at':'2015-09-02T00:00:00.000Z'},
      {'created_at':'2015-09-03T00:00:00.000Z'},
      {'created_at':'2015-09-04T00:00:00.000Z'},
      {'created_at':'2015-09-05T00:00:00.000Z'},
      {'created_at':'2015-09-06T00:00:00.000Z'},
      {'created_at':'2015-09-07T00:00:00.000Z'}
    ],
    '/api/v1/devicestatus.json&find[created_at][$gte]=2015-08-08T00:00:00.000Z&find[created_at][$lt]=2015-09-07T23:59:59.000Z?find[openaps][$exists]=true&count=1000': [
      {
        'openaps': {
            'suggested': {
                'temp': 'absolute',
                'bg': 67,
                'tick': '+6',
                'eventualBG': 145,
                'snoozeBG': 145,
                'reason': 'BG 67<74.5, delta 6>0; no high-temp to cancel',
                'timestamp': '2015-08-31T00:00:00.000Z'
            }
        },
        'created_at': '2015-08-31T00:00:00.000Z'
      }
    ]

  };

var exampleProfile = [
  {
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
  }
];

exampleProfile[0].startDate.setSeconds(0);
exampleProfile[0].startDate.setMilliseconds(0);


describe('reports', function ( ) {
  var self = this;
  var headless = require('./fixtures/headless')(benv, this);
  this.timeout(80000);
  
  before(function (done) {
    done( );
  });

  after(function (done) {
    done( );
  });

  beforeEach(function (done) {
    var opts = {
      htmlFile: __dirname + '/../views/reportindex.html'
    , mockProfileEditor: true
    , serverSettings: serverSettings
    , mockSimpleAjax: someData
    , benvRequires: [
       __dirname + '/../static/report/js/report.js'
      ]
    };
    headless.setup(opts, done);
  });

  afterEach(function (done) {
    headless.teardown( );
    done( );
  });


  it ('should produce some html', function (done) {
    var client = window.Nightscout.client;

    var hashauth = require('../lib/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

     window.confirm = function mockConfirm () {
       return true;
     };

     window.alert = function mockAlert () {
       return true;
     };

     window.setTimeout = function mockSetTimeout (call) {
       call();
     };

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

		console.log('Sending profile to client');

      // Load profile, we need to operate in UTC
      client.sbx.data.profile.loadData(exampleProfile);

      $('#treatments').addClass('selected');
      $('a.presetdates :first').click();
      $('#rp_notes').val('something');
      $('#rp_eventtype').val('BG Check');
      $('#rp_from').val('2015-08-08');
      $('#rp_to').val('2015-09-07');
      $('#rp_optionsraw').prop('checked', true);
      $('#rp_optionsiob').prop('checked', true);
      $('#rp_optionscob').prop('checked', true);
      $('#rp_enableeventtype').click();
      $('#rp_enablenotes').click();
      $('#rp_enablefood').click();
      $('#rp_enablefood').click();
      $('#rp_log').prop('checked', true);
      $('#rp_optionsopenaps').prop('checked', true);
      $('#rp_show').click();

      $('#rp_linear').prop('checked', true);
      $('#rp_show').click();
      $('#dailystats').click();

      $('img.deleteTreatment:first').click();
      $('img.editTreatment:first').click();
      $('.ui-button:contains("Save")').click();

      var result = $('body').html();
      //var filesys = require('fs');
      //var logfile = filesys.createWriteStream('out.txt', { flags: 'a'} )
      //logfile.write(result);
      //console.log('RESULT', result);
      
      result.indexOf('Milk now').should.be.greaterThan(-1); // daytoday
      result.indexOf('50 g').should.be.greaterThan(-1); // daytoday
      result.indexOf('TDD average:</b> 2.9U').should.be.greaterThan(-1); // daytoday
      result.indexOf('<td class="tdborder">0%</td><td class="tdborder">100%</td><td class="tdborder">0%</td><td class="tdborder">2</td>').should.be.greaterThan(-1); //dailystats
      //TODO FIXME result.indexOf('td class="tdborder" style="background-color:#8f8"><strong>Normal: </strong></td><td class="tdborder">64.7%</td><td class="tdborder">6</td>').should.be.greaterThan(-1); // distribution
      result.indexOf('<td>16 (100%)</td>').should.be.greaterThan(-1); // hourlystats
      result.indexOf('<div id="success-grid">').should.be.greaterThan(-1); //success
      result.indexOf('<b style="padding-left:4em">CAL</b>:  Scale: 1.10 Intercept: 31102 Slope: 776.91').should.be.greaterThan(-1); //calibrations
      result.indexOf('<td>Correction Bolus</td><td align="center">250 (Sensor)</td><td align="center">0.75</td>').should.be.greaterThan(-1); //treatments

      done();
    });
  });

  it ('should produce week to week report', function (done) {
    var client = window.Nightscout.client;

    var hashauth = require('../lib/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

     window.confirm = function mockConfirm () {
       return true;
     };

     window.alert = function mockAlert () {
       return true;
     };

     window.setTimeout = function mockSetTimeout (call) {
       call();
     };

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

		console.log('Sending profile to client');

      // Load profile, we need to operate in UTC
      client.sbx.data.profile.loadData(exampleProfile);

      $('#weektoweek').addClass('selected');
      $('a.presetdates :first').click();
      $('#rp_from').val('2015-08-08');
      $('#rp_to').val('2015-09-07');
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      var result = $('body').html();

      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(73, 22, 153)"').should.be.greaterThan(-1); // weektoweek Sunday sample point
      result.indexOf('<circle cx="35" cy="267.34375" fill="rgb(34, 201, 228)"').should.be.greaterThan(-1); // weektoweek Monday sample point
      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(0, 153, 123)"').should.be.greaterThan(-1); // weektoweek Tuesday sample point
      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(135, 135, 228)"').should.be.greaterThan(-1); // weektoweek Wednesday sample point
      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(135, 49, 204)"').should.be.greaterThan(-1); // weektoweek Thursday sample point
      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(36, 36, 228)"').should.be.greaterThan(-1); // weektoweek Friday sample point
      result.indexOf('<circle cx="978" cy="267.34375" fill="rgb(0, 234, 188)"').should.be.greaterThan(-1); // weektoweek Saturday sample point

      done();
    });
  });
});
