'use strict';

require('should');
var assert = require('node:assert/strict');
var benv = require('./fixtures/benv-loader');
var moment = require('moment');

var nowData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
  , treatments: []
};

var profileData = {
  defaultProfile: 'Default'
  , units: 'mg/dl'
  , store: {
    Default: {
      dia: 3
      , units: 'mg/dl'
      , basal: [{time: '00:00', timeAsSeconds: 0, value: 1}]
      , carbratio: [{time: '00:00', timeAsSeconds: 0, value: 10}]
      , sens: [{time: '00:00', timeAsSeconds: 0, value: 50}]
      , target_low: [{time: '00:00', timeAsSeconds: 0, value: 100}]
      , target_high: [{time: '00:00', timeAsSeconds: 0, value: 120}]
    }
  }
};

var boluscalcData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
  , treatments: []
  , devicestatus: []
  , profiles: [profileData]
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('careportal', function ( ) {
  this.timeout(60000); // TODO: see why this test takes longer on Travis to complete

  var headless = require('./fixtures/headless')(benv, this);

  before(function (done) {

    const t = Date.now();
    console.log('Starting headless setup for Careportal test');
    
    function d () {
      console.log('Done called by headless', Date.now() - t );
      done();
    }

    headless.setup({mockAjax: true}, d);
    console.log('Headless setup for Careportal test done');
  });

  after(function (done) {
    headless.teardown( );
    done( );
  });

  function mockMomentNow (client, time) {
    var fakeNow = moment.parseZone(time);

    client.ctx.moment = function mockMoment (value) {
      if (value === undefined) {
        return fakeNow.clone();
      }
      return moment(value);
    };
  }

  function selectRadio (nowSelector, otherSelector) {
    $(nowSelector).removeAttr('checked').prop('checked', false);
    $(otherSelector).attr('checked', 'checked').prop('checked', true);
  }

  function mockTreatmentPost () {
    var mocks = {
      ajax: $.ajax
      , confirm: window.confirm
      , alert: window.alert
      , treatment: undefined
    };

    $.ajax = function mockAjax (request) {
      mocks.treatment = request.data;

      return {
        done: function mockDone (fn) {
          fn({message: 'OK'});
          return this;
        }
        , fail: function mockFail () {
          return this;
        }
      };
    };

    window.confirm = function mockConfirm () {
      return true;
    };
    window.alert = function mockAlert (messages) {
      messages.should.equal('');
    };

    return mocks;
  }

  function restoreTreatmentPost (mocks) {
    $.ajax = mocks.ajax;
    window.confirm = mocks.confirm;
    window.alert = mocks.alert;
  }

  it ('open careportal, and enter a treatment', async () =>{

    console.log('Careportal test client start');

    var client = window.Nightscout.client;

    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) { 
      hashauth.authenticated = true;
      next(true); 
    };

    console.log('Careportal test client init');
    client.init();
    sleep(50);

    console.log('Careportal test client data update');
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

    window.alert = function mockAlert(messages) { messages.should.equal(''); };
    
    console.log('Careportal test saving');

    client.careportal.save();

  });

  [
    {
      time: '2024-10-25T23:00:00-05:00'
      , expectedDate: '2024-10-25'
      , expectedTime: '23:00'
      , utcDate: '2024-10-26'
    }
    , {
      time: '2024-10-26T01:00:00+03:00'
      , expectedDate: '2024-10-26'
      , expectedTime: '01:00'
      , utcDate: '2024-10-25'
    }
  ].forEach(function eachCase (testCase) {
    it('uses local timezone date, not UTC, when saving an other-time treatment (8304) ' + testCase.time, function () {
      var client = window.Nightscout.client;
      client.init();
      mockMomentNow(client, testCase.time);

      client.careportal.prepare();

      $('#eventDateValue').val().should.equal(testCase.expectedDate);
      $('#eventTimeValue').val().should.equal(testCase.expectedTime);

      $('#eventType').val('BG Check');
      $('#glucoseValue').val('100');
      selectRadio('#nowtime', '#othertime');
      client.careportal.eventTimeTypeChange();

      var mocks = mockTreatmentPost();

      try {
        client.careportal.save();
      } finally {
        restoreTreatmentPost(mocks);
      }

      var expectedCreatedAt = client.utils.mergeInputTime(testCase.expectedTime, testCase.expectedDate).toDate().toISOString();

      mocks.treatment.eventType.should.equal('BG Check');
      mocks.treatment.created_at.should.equal(expectedCreatedAt);
      mocks.treatment.created_at.should.not.equal(client.utils.mergeInputTime(testCase.expectedTime, testCase.utcDate).toDate().toISOString());
    });
  });

  it('uses local timezone date, not UTC, when saving a boluscalc other-time treatment', function () {
    var client = window.Nightscout.client;
    client.init();
    client.dataUpdate(boluscalcData, true);
    mockMomentNow(client, '2024-10-26T01:00:00+03:00');

    client.boluscalc.prepare();

    $('#bc_eventDateValue').val().should.equal('2024-10-26');
    $('#bc_eventTimeValue').val().should.equal('01:00');

    $('#bc_bg').val('100');
    $('#bc_carbs').val('10');
    selectRadio('#bc_nowtime', '#bc_othertime');
    client.boluscalc.eventTimeTypeChange();

    var mocks = mockTreatmentPost();

    try {
      client.boluscalc.submit();
    } finally {
      restoreTreatmentPost(mocks);
    }

    var expectedEventTime = client.utils.mergeInputTime('01:00', '2024-10-26').toDate().toISOString();
    var utcShiftedEventTime = client.utils.mergeInputTime('01:00', '2024-10-25').toDate().toISOString();

    mocks.treatment.eventType.should.equal('Bolus Wizard');
    mocks.treatment.eventTime.toISOString().should.equal(expectedEventTime);
    mocks.treatment.boluscalc.eventTime.should.equal(expectedEventTime);
    mocks.treatment.boluscalc.eventTime.should.not.equal(utcShiftedEventTime);
  });

  function checkLoopSubmission (eventType, failureMessage) {
    var client = window.Nightscout.client;
    client.init();
    var loop = require('../lib/plugins/loop')(client.ctx);
    var loopEvents = loop.getEventTypes({
      settings: client.settings,
      data: { profile: { data: [{ loopSettings: {
        overridePresets: [{ name: 'test-override', symbol: '', duration: 1800 }]
      } }] } }
    });
    var original = {
      getAllEventTypes: client.plugins.getAllEventTypes,
      ajax: $.ajax,
      confirm: window.confirm,
      alert: window.alert,
      globalAlert: Object.getOwnPropertyDescriptor(global, 'alert'),
      closeDrawer: client.browserUtils.closeDrawer
    };
    var alerts = [];
    var closedDrawers = [];
    var requests = [];

    try {
      client.plugins.getAllEventTypes = function (sbx) {
        return original.getAllEventTypes.call(client.plugins, sbx).concat(loopEvents);
      };
      client.careportal.prepare();
      $('#eventType').val(eventType);
      client.careportal.filterInputs();
      $('#reason').val('test-override');
      $('#remoteCarbs').val('10');
      $('#remoteBolus').val('1');
      $('#notes').val('Keep these notes');
      $('#enteredBy').val('Test user');
      window.confirm = function () { return true; };
      window.alert = function (message) { alerts.push(message); };
      // The Node-based bundle harness does not alias alert to window.alert.
      global.alert = window.alert;
      client.browserUtils.closeDrawer = function (selector) { closedDrawers.push(selector); };
      $.ajax = function (options) {
        requests.push(options);
        return {
          done: function (callback) { if (!failureMessage) { callback(); } return this; },
          fail: function (callback) {
            if (failureMessage) { callback({ status: 500, responseText: failureMessage }); }
            return this;
          }
        };
      };

      client.careportal.save();

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/api/v2/notifications/loop');
      assert.equal(requests[0].data.eventType, eventType);
      if (failureMessage) {
        assert.deepEqual(alerts, ['Error: ' + failureMessage]);
        assert.deepEqual(closedDrawers, []);
        assert.equal($('#eventType').val(), eventType);
        assert.equal($('#notes').val(), 'Keep these notes');
        assert.equal($('#enteredBy').val(), 'Test user');
        if (eventType === 'Remote Carbs Entry') { assert.equal($('#remoteCarbs').val(), '10'); }
        if (eventType === 'Remote Bolus Entry') { assert.equal($('#remoteBolus').val(), '1'); }
      } else {
        assert.deepEqual(alerts, []);
        assert.deepEqual(closedDrawers, ['#treatmentDrawer']);
      }
    } finally {
      client.plugins.getAllEventTypes = original.getAllEventTypes;
      $.ajax = original.ajax;
      window.confirm = original.confirm;
      window.alert = original.alert;
      if (original.globalAlert) {
        Object.defineProperty(global, 'alert', original.globalAlert);
      } else {
        delete global.alert;
      }
      client.browserUtils.closeDrawer = original.closeDrawer;
    }
  }

  [
    ['Temporary Override', 'Loop notification failed: LOOP_APNS_KEY not set.'],
    ['Temporary Override Cancel', 'Loop notification failed: Could not find deviceToken in loopSettings.'],
    ['Remote Carbs Entry', 'Loop remote carbs failed. Incorrect carbs entry: '],
    ['Remote Bolus Entry', 'APNs delivery failed: InvalidProviderToken']
  ].forEach(function (testCase) {
    it('shows the actionable failure and preserves the form for ' + testCase[0], function () {
      var errorMessage = require('../lib/api2/loop-notification-errors')(testCase[1]);
      checkLoopSubmission(testCase[0], errorMessage);
    });
  });

  it('closes the form after a successful Loop remote command without an error alert', function () {
    checkLoopSubmission('Temporary Override Cancel');
  });

});
