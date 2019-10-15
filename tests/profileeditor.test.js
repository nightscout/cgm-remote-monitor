'use strict';

require('should');
var _ = require('lodash');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

var nowData = require('../lib/data/ddata')();
nowData.sgvs.push({ mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' });

var exampleProfile = {
  defaultProfile : 'Default'
  , store: {
      'Default' : {
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
            'value': 100
          }],
        'target_high':[
          {
            'time': '00:00',
            'value': 120
          }]
      }
  }
};


var someData = {
    '/api/v1/profile.json': [exampleProfile]
  };


describe('Profile editor', function ( ) {
  this.timeout(40000); //TODO: see why this test takes longer on Travis to complete
  var headless = require('./fixtures/headless')(benv, this);

  before(function (done) {
    done( );
  });

  after(function (done) {
    done( );
  });

  beforeEach(function (done) {
    var opts = {
      htmlFile: __dirname + '/../views/profileindex.html'
    , mockProfileEditor: true
    , mockAjax: someData
    , benvRequires: [
        __dirname + '/../static/profile/js/profileeditor.js'
      ]
    };
    headless.setup(opts, done);
  });

  afterEach(function (done) {
    headless.teardown( );
    done( );
  });

  it ('should produce some html', function (done) {
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

    client.init();
    client.dataUpdate(nowData);
    
    //var result = $('body').html();
    //var filesys = require('fs');
    //var logfile = filesys.createWriteStream('out.html', { flags: 'a'} )
    //logfile.write($('body').html());
    
    // database records manipulation
    $('#pe_databaserecords option').length.should.be.equal(1);
    $('#pe_records_add').click();
    $('#pe_databaserecords option').length.should.be.equal(2);
    $('#pe_records_remove').click();
    $('#pe_databaserecords option').length.should.be.equal(1);
    $('#pe_records_clone').click();
    $('#pe_databaserecords option').length.should.be.equal(2);
    $('#pe_databaserecords option').val(0);

    //console.log($('#pe_databaserecords').html());
    //console.log($('#pe_databaserecords').val());

    // database records manipulation
    $('#pe_profiles option').length.should.be.equal(1);
    $('#pe_profile_add').click();
    $('#pe_profiles option').length.should.be.equal(2);
    $('#pe_profile_name').val('Test');
    $('#pe_profiles option').val('Default');
    $('#pe_profiles option').val('Test');
    $('#pe_profile_remove').click();
    $('#pe_profiles option').length.should.be.equal(1);
    $('#pe_profile_clone').click();
    $('#pe_profiles option').length.should.be.equal(2);
    $('#pe_profiles option').val('Default');

    //console.log($('#pe_profiles').html());
    //console.log($('#pe_profiles').val());


    // I:C range
    $('#pe_ic_val_0').val().should.be.equal('30');
    $('#pe_ic_placeholder').find('img.addsingle').click();
    $('#pe_ic_val_0').val().should.be.equal('0');
    $('#pe_ic_val_1').val().should.be.equal('30');
    $('#pe_ic_placeholder').find('img.delsingle').click();
    $('#pe_ic_val_0').val().should.be.equal('30');

    // traget bg range
    $('#pe_targetbg_low_0').val().should.be.equal('100');
    $('#pe_targetbg_placeholder').find('img.addtargetbg').click();
    $('#pe_targetbg_low_0').val().should.be.equal('0');
    $('#pe_targetbg_low_1').val().should.be.equal('100');
    $('#pe_targetbg_placeholder').find('img.deltargetbg').click();
    $('#pe_targetbg_low_0').val().should.be.equal('100');


    $('#pe_submit').click();
    done();
  });

});
