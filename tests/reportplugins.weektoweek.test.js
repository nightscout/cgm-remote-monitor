'use strict';

require('should');
var _ = require('lodash');
var benv = require('benv');
var serverSettings = require('./fixtures/default-server-settings');

var nowData = {
  sgvs: [
    { mgdl: 100, mills: Date.now(), direction: 'Flat', type: 'sgv' }
  ]
  , treatments: []
};

function buildProfile (timezone) {
  return [
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
    'timezone': timezone,

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
}

describe('weektoweek reports', function ( ) {
  var headless = require('./fixtures/headless')(benv, this);

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
    , mockSimpleAjax: {}
    , benvRequires: [
       __dirname + '/../static/js/reportinit.js'
      ]
    };
    headless.setup(opts, done);
  });

  afterEach(function (done) {
    // Unset the process TZ
    delete process.env.TZ;

    headless.teardown( );
    done( );
  });

  it ('should produce week to week report', function (done) {
    const testTimezone = 'Etc/UTC';

    var client = window.Nightscout.client;

    var hashauth = require('../lib/client/hashauth');
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

    window.setTimeout = function mockSetTimeout (call, timer) {
      if (timer == 60000) return;
      call();
    };

    window.Nightscout.reportclient();

    // Because we're looking at date headings, we need to force a
    // specific timezone
    process.env.TZ = testTimezone;

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

      console.log('Sending profile to client');

      // Load profile matching browser timezone
      client.sbx.data.profile.loadData(buildProfile(testTimezone));

      $('#weektoweek').click();
      $('a.presetdates :first').click();
      $('#rp_from').val('2015-08-08');
      $('#rp_to').val('2015-09-07');
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      var result = $('body').html();

      // Select bold text as a child of the chart
      var charts = $('#weektoweekcharts b');

      // check the titles
      result.indexOf('<h2>Week to week</h2>').should.be.greaterThan(-1);

      charts.length.should.equal(5);

      charts[0].textContent.should.equal('Tuesday 09/01/2015-Monday 09/07/2015');
      charts[1].textContent.should.equal('Tuesday 08/25/2015-Monday 08/31/2015');
      charts[2].textContent.should.equal('Tuesday 08/18/2015-Monday 08/24/2015');
      charts[3].textContent.should.equal('Tuesday 08/11/2015-Monday 08/17/2015');
      charts[4].textContent.should.equal('Saturday 08/08/2015-Monday 08/10/2015');

      // Verify week-to-week report renders circles with expected day-of-week colors
      // Note: Exact coordinates are not checked as they vary with chart dimensions
      result.indexOf('fill="rgb(73, 22, 153)"').should.be.greaterThan(-1); // Sunday color
      result.indexOf('fill="rgb(34, 201, 228)"').should.be.greaterThan(-1); // Monday color
      result.indexOf('fill="rgb(0, 153, 123)"').should.be.greaterThan(-1); // Tuesday color
      result.indexOf('fill="rgb(135, 135, 228)"').should.be.greaterThan(-1); // Wednesday color
      result.indexOf('fill="rgb(135, 49, 204)"').should.be.greaterThan(-1); // Thursday color
      result.indexOf('fill="rgb(36, 36, 228)"').should.be.greaterThan(-1); // Friday color
      result.indexOf('fill="rgb(0, 234, 188)"').should.be.greaterThan(-1); // Saturday color

      done();
    });
  });

  it ('should produce week to week report in a negative offset timezone', function (done) {
    const startDateString = '2015-08-08';
    const endDateString = '2015-09-07';

    const browserTimezone = 'Etc/GMT+6'; // Etc offsets are reversed
    const profileTimezone = browserTimezone;

    var client = window.Nightscout.client;
    var jqueryAjax = window.$.ajax.bind({}); // Hold a reference so we can check the call args

    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

    var requestUrls = [];

    window.$.ajax = function mockAjax (url, settings) {
        if (typeof(url) === 'string') {
            if (url.startsWith('/api/v1/entries.json')) {
                requestUrls.push(url);
            }
        }

        return jqueryAjax(url, settings);
    }

    window.confirm = function mockConfirm () {
      return true;
    };

    window.alert = function mockAlert () {
      return true;
    };

    window.setTimeout = function mockSetTimeout (call, timer) {
      if (timer == 60000) return;
      call();
    };

    window.Nightscout.reportclient();

    // Because we're looking at date headings, we need to force a
    // specific timezone

    // Set the process / system TZ for tests
    process.env.TZ = browserTimezone;

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

      console.log('Sending profile to client');

      // Set the profile timezone to something different from the browser timezone
      client.sbx.data.profile.loadData(buildProfile(profileTimezone));

      $('#weektoweek').click();
      $('a.presetdates :first').click();
      $('#rp_from').val(startDateString);
      $('#rp_to').val(endDateString);
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      // Select bold text as a child of the chart
      var charts = $('#weektoweekcharts b');

      charts.length.should.equal(5);

      charts[0].textContent.should.equal('Tuesday 09/01/2015-Monday 09/07/2015');
      charts[1].textContent.should.equal('Tuesday 08/25/2015-Monday 08/31/2015');
      charts[2].textContent.should.equal('Tuesday 08/18/2015-Monday 08/24/2015');
      charts[3].textContent.should.equal('Tuesday 08/11/2015-Monday 08/17/2015');
      charts[4].textContent.should.equal('Saturday 08/08/2015-Monday 08/10/2015');

      //TODO: Fix duplicate API calls
      requestUrls = _.uniq(requestUrls);

      var startMoment = window.moment(startDateString).startOf('day');
      var endMoment = window.moment(endDateString).endOf('day');

      //We need to add a day, because the results do not end at the start of
      //the day as represented by endMoment, but the end of the day
      var numberOfDays = endMoment.diff(startMoment, 'days') + 1;

      requestUrls.length.should.equal(numberOfDays);

      for (var i = 0; i < numberOfDays; i++) {
        var requestStartMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i, 'days');
        var requestEndMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i + 1, 'days');

        requestUrls[i].should.equal('/api/v1/entries.json?find[date][$gte]=' + requestStartMoment.format('x') + '&find[date][$lt]=' + requestEndMoment.format('x') + '&count=10000');
      }

      done();
    });
  });

  it ('should produce week to week report in a positive offset timezone', function (done) {
    const startDateString = '2015-08-08';
    const endDateString = '2015-09-07';

    const browserTimezone = 'Etc/GMT-6'; // Etc offsets are reversed
    const profileTimezone = browserTimezone;

    var client = window.Nightscout.client;
    var jqueryAjax = window.$.ajax.bind({}); // Hold a reference so we can check the call args

    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

    var requestUrls = [];

    window.$.ajax = function mockAjax (url, settings) {
        if (typeof(url) === 'string') {
            if (url.startsWith('/api/v1/entries.json')) {
                requestUrls.push(url);
            }
        }

        return jqueryAjax(url, settings);
    }

    window.confirm = function mockConfirm () {
      return true;
    };

    window.alert = function mockAlert () {
      return true;
    };

    window.setTimeout = function mockSetTimeout (call, timer) {
      if (timer == 60000) return;
      call();
    };

    window.Nightscout.reportclient();

    // Because we're looking at date headings, we need to force a
    // specific timezone

    // Set the process / system TZ for tests
    process.env.TZ = browserTimezone;

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

      console.log('Sending profile to client');

      // Set the profile timezone to something different from the browser timezone
      client.sbx.data.profile.loadData(buildProfile(profileTimezone));

      $('#weektoweek').click();
      $('a.presetdates :first').click();
      $('#rp_from').val(startDateString);
      $('#rp_to').val(endDateString);
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      // Select bold text as a child of the chart
      var charts = $('#weektoweekcharts b');

      charts.length.should.equal(5);

      charts[0].textContent.should.equal('Tuesday 09/01/2015-Monday 09/07/2015');
      charts[1].textContent.should.equal('Tuesday 08/25/2015-Monday 08/31/2015');
      charts[2].textContent.should.equal('Tuesday 08/18/2015-Monday 08/24/2015');
      charts[3].textContent.should.equal('Tuesday 08/11/2015-Monday 08/17/2015');
      charts[4].textContent.should.equal('Saturday 08/08/2015-Monday 08/10/2015');

      //TODO: Fix duplicate API calls
      requestUrls = _.uniq(requestUrls);

      var startMoment = window.moment(startDateString).startOf('day');
      var endMoment = window.moment(endDateString).endOf('day');

      //We need to add a day, because the results do not end at the start of
      //the day as represented by endMoment, but the end of the day
      var numberOfDays = endMoment.diff(startMoment, 'days') + 1;

      requestUrls.length.should.equal(numberOfDays);

      for (var i = 0; i < numberOfDays; i++) {
        var requestStartMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i, 'days');
        var requestEndMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i + 1, 'days');

        requestUrls[i].should.equal('/api/v1/entries.json?find[date][$gte]=' + requestStartMoment.format('x') + '&find[date][$lt]=' + requestEndMoment.format('x') + '&count=10000');
      }

      done();
    });
  });

  it ('should produce week to week report in the requested range when the requested start date in the browser would change after profile timezone application', function (done) {
    const startDateString = '2015-08-08';
    const endDateString = '2015-09-07';

    const browserTimezone = 'Etc/UTC';
    const profileTimezone = 'Etc/GMT+6';

    var client = window.Nightscout.client;
    var jqueryAjax = window.$.ajax.bind({}); // Hold a reference so we can check the call args

    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

    var requestUrls = [];

    window.$.ajax = function mockAjax (url, settings) {
        if (typeof(url) === 'string') {
            if (url.startsWith('/api/v1/entries.json')) {
                requestUrls.push(url);
            }
        }

        return jqueryAjax(url, settings);
    }

    window.confirm = function mockConfirm () {
      return true;
    };

    window.alert = function mockAlert () {
      return true;
    };

    window.setTimeout = function mockSetTimeout (call, timer) {
      if (timer == 60000) return;
      call();
    };

    window.Nightscout.reportclient();

    // Because we're looking at date headings, we need to force a
    // specific timezone

    // Set the process / system TZ for tests
    process.env.TZ = browserTimezone;

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

      console.log('Sending profile to client');

      // Set the profile timezone to something different from the browser timezone
      client.sbx.data.profile.loadData(buildProfile(profileTimezone));

      $('#weektoweek').click();
      $('a.presetdates :first').click();
      $('#rp_from').val(startDateString);
      $('#rp_to').val(endDateString);
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      // Select bold text as a child of the chart
      var charts = $('#weektoweekcharts b');

      charts.length.should.equal(5);

      charts[0].textContent.should.equal('Tuesday 09/01/2015-Monday 09/07/2015');
      charts[1].textContent.should.equal('Tuesday 08/25/2015-Monday 08/31/2015');
      charts[2].textContent.should.equal('Tuesday 08/18/2015-Monday 08/24/2015');
      charts[3].textContent.should.equal('Tuesday 08/11/2015-Monday 08/17/2015');
      charts[4].textContent.should.equal('Saturday 08/08/2015-Monday 08/10/2015');

      //TODO: Fix duplicate API calls
      requestUrls = _.uniq(requestUrls);

      var startMoment = window.moment(startDateString).startOf('day');
      var endMoment = window.moment(endDateString).endOf('day');

      //We need to add a day, because the results do not end at the start of
      //the day as represented by endMoment, but the end of the day
      var numberOfDays = endMoment.diff(startMoment, 'days') + 1;

      requestUrls.length.should.equal(numberOfDays);

      for (var i = 0; i < numberOfDays; i++) {
        var requestStartMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i, 'days');
        var requestEndMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i + 1, 'days');

        requestUrls[i].should.equal('/api/v1/entries.json?find[date][$gte]=' + requestStartMoment.format('x') + '&find[date][$lt]=' + requestEndMoment.format('x') + '&count=10000');
      }

      done();
    });
  });

  it ('should produce week to week report in the requested range when the requested end date in the browser would change after profile timezone application', function (done) {
    const startDateString = '2015-08-08';
    const endDateString = '2015-09-07';

    const browserTimezone = 'Etc/UTC';
    const profileTimezone = 'Etc/GMT-6';

    var client = window.Nightscout.client;
    var jqueryAjax = window.$.ajax.bind({}); // Hold a reference so we can check the call args

    var hashauth = require('../lib/client/hashauth');
    hashauth.init(client,$);
    hashauth.verifyAuthentication = function mockVerifyAuthentication(next) {
      hashauth.authenticated = true;
      next(true);
    };

    var requestUrls = [];

    window.$.ajax = function mockAjax (url, settings) {
        if (typeof(url) === 'string') {
            if (url.startsWith('/api/v1/entries.json')) {
                requestUrls.push(url);
            }
        }

        return jqueryAjax(url, settings);
    }

    window.confirm = function mockConfirm () {
      return true;
    };

    window.alert = function mockAlert () {
      return true;
    };

    window.setTimeout = function mockSetTimeout (call, timer) {
      if (timer == 60000) return;
      call();
    };

    window.Nightscout.reportclient();

    // Because we're looking at date headings, we need to force a
    // specific timezone

    // Set the process / system TZ for tests
    process.env.TZ = browserTimezone;

    client.init(function afterInit ( ) {
      client.dataUpdate(nowData);

      console.log('Sending profile to client');

      // Set the profile timezone to something different from the browser timezone
      client.sbx.data.profile.loadData(buildProfile(profileTimezone));

      $('#weektoweek').click();
      $('a.presetdates :first').click();
      $('#rp_from').val(startDateString);
      $('#rp_to').val(endDateString);
      $('#wrp_log').prop('checked', true);
      $('#rp_show').click();

      $('#wrp_linear').prop('checked', true);
      $('#rp_show').click();
      $('.ui-button:contains("Save")').click();

      // Select bold text as a child of the chart
      var charts = $('#weektoweekcharts b');

      charts.length.should.equal(5);

      charts[0].textContent.should.equal('Tuesday 09/01/2015-Monday 09/07/2015');
      charts[1].textContent.should.equal('Tuesday 08/25/2015-Monday 08/31/2015');
      charts[2].textContent.should.equal('Tuesday 08/18/2015-Monday 08/24/2015');
      charts[3].textContent.should.equal('Tuesday 08/11/2015-Monday 08/17/2015');
      charts[4].textContent.should.equal('Saturday 08/08/2015-Monday 08/10/2015');

      //TODO: Fix duplicate API calls
      requestUrls = _.uniq(requestUrls);

      var startMoment = window.moment(startDateString).startOf('day');
      var endMoment = window.moment(endDateString).endOf('day');

      //We need to add a day, because the results do not end at the start of
      //the day as represented by endMoment, but the end of the day
      var numberOfDays = endMoment.diff(startMoment, 'days') + 1;

      requestUrls.length.should.equal(numberOfDays);

      for (var i = 0; i < numberOfDays; i++) {
        var requestStartMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i, 'days');
        var requestEndMoment = window.moment.tz(window.moment.tz(startDateString, browserTimezone).startOf('day'), profileTimezone).add(i + 1, 'days');

        requestUrls[i].should.equal('/api/v1/entries.json?find[date][$gte]=' + requestStartMoment.format('x') + '&find[date][$lt]=' + requestEndMoment.format('x') + '&count=10000');
      }

      done();
    });
  });
});
