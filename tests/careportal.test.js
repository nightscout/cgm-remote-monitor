'use strict';

require('should');
var benv = require('benv');

var nowData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
  , treatments: []
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('client', function ( ) {
  this.timeout(40000); // TODO: see why this test takes longer on Travis to complete

  var headless = require('./fixtures/headless')(benv, this);

  before(function (done) {
    done( );
  });

  after(function (done) {
    done( );
  });

  beforeEach(function (done) {
    headless.setup({mockAjax: true}, done);
  });

  afterEach(function (done) {
    headless.teardown( );
    done( );
  });

  it ('open careportal, and enter a treatment', async () =>{

	var client = window.Nightscout.client;
	
    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    client.init();
    sleep(50);

    client.dataUpdate(nowData, true);
    sleep(50);

    client.careportal.prepareEvents();

    $('#eventType').val('Snack Bolus');
    $('#glucoseValue').val('100');
    $('#carbsGiven').val('10');
    $('#insulinGiven').val('0.60');
    $('#preBolus').val(15);
    $('#notes').val('Testing');
    $('#enteredBy').val('Dad');

    //simulate some events
    client.careportal.eventTimeTypeChange();
    client.careportal.dateTimeFocus();
    client.careportal.dateTimeChange();

    window.confirm = function mockConfirm (message) {
      function containsLine (line) {
        message.indexOf(line + '\n').should.be.greaterThan(0);
      }

      containsLine('Event Type: Snack Bolus');
      containsLine('Blood Glucose: 100');
      containsLine('Carbs Given: 10');
      containsLine('Insulin Given: 0.60');
      containsLine('Carb Time: 15 mins');
      containsLine('Notes: Testing');
      containsLine('Entered By: Dad');

      return true;
    };

    window.alert = function mockAlert() {};
    
    client.careportal.save();

  });

});
