'use strict';

var should = require('should');
var benv = require('./fixtures/benv-loader');
var _ = require('lodash');
var moment = require('moment-timezone');

var someData = {
  // Preview GET endpoints
  '/api/v1/entries.json': [
    { _id: 'e1', date: 1735689600000, sgv: 100, type: 'sgv' },
    { _id: 'e2', date: 1735776000000, sgv: 110, type: 'sgv' },
    { _id: 'e3', date: 1735862400000, sgv: 120, type: 'sgv' }
  ],
  '/api/v1/treatments.json': [
    { _id: 't1', created_at: '2025-01-01T00:00:00.000Z', carbs: 10 },
    { _id: 't2', created_at: '2025-01-02T00:00:00.000Z', carbs: 20 }
  ],
  '/api/v1/devicestatus.json': [
    { _id: 'd1', created_at: '2025-01-01T00:00:00.000Z', uploaderBattery: 80 }
  ],
  // DELETE endpoints
  '/api/v1/entries/': { n: 3 },
  '/api/v1/treatments/': { n: 2 },
  '/api/v1/devicestatus/': { n: 1 }
};

function createTranslateMock() {
  return function(key, options) {
    if (options && options.params) {
      var str = key;
      options.params.forEach(function(p, i) {
        str = str.replace('%' + (i + 1), p);
      });
      return str;
    }
    return key;
  };
}

describe('daterangedelete admin plugin (TZ aware)', function() {
  var $, client, daterangedelete, adminIndex;
  this.timeout(5000);

  before(function(done) {
    benv.setup(function() {
      $ = require('jquery');
      global.$ = $;

      window.alert = function() {};
      window.confirm = function() { return true; };
      $.fn.fadeIn = function() { return this; };
      $.fn.hide = function() { return this; };

      $.ajax = function mockAjax(arg1, arg2) {
        var opts = typeof arg1 === 'string' ? arg2 : arg1;
        var url = typeof arg1 === 'string' ? arg1 : opts.url;

        var response;
        if (url.indexOf('/api/v1/entries.json') === 0) response = someData['/api/v1/entries.json'];
        else if (url.indexOf('/api/v1/treatments.json') === 0) response = someData['/api/v1/treatments.json'];
        else if (url.indexOf('/api/v1/devicestatus.json') === 0) response = someData['/api/v1/devicestatus.json'];
        else if (url.indexOf('/api/v1/entries/*') === 0) {
            should(url).containEql('count=100000');
            response = someData['/api/v1/entries/'];
        }
        else if (url.indexOf('/api/v1/treatments/') === 0) {
            should(url).containEql('count=100000');
            response = someData['/api/v1/treatments/'];
        }
        else if (url.indexOf('/api/v1/devicestatus/') === 0) {
            should(url).containEql('count=100000');
            response = someData['/api/v1/devicestatus/'];
        }
        else response = { n: 0 };

        if (opts && opts.success) opts.success(response);

        var thenable = function(cb) { if (cb) cb(response); return thenable; };
        _.assign(thenable, { done: thenable, fail: thenable, always: thenable, then: thenable });
        return thenable;
      };

      $('body').html('<div id="admin_placeholder"></div>');

      var ctx = { moment: moment };
      daterangedelete = require('../lib/admin_plugins/daterangedelete')(ctx);
      adminIndex = require('../lib/admin_plugins/index')(ctx);

      client = {
        translate: createTranslateMock(),
        headers: function() { return {}; },
        hashauth: { isAuthenticated: function() { return true; } },
        sbx: {
            data: {
                profile: {
                    getTimezone: function() { return 'America/New_York'; }
                }
            }
        }
      };

      window.Nightscout = { client: client, admin_plugins: adminIndex };
      adminIndex.createHTML(client);

      done();
    });
  });

  after(function(done) {
    benv.teardown(true);
    done();
  });

  it('should verify that queries respect America/New_York timezone', function() {
    var capturedUrls = [];
    var originalAjax = $.ajax;
    $.ajax = function(url) {
        capturedUrls.push(typeof url === 'string' ? url : url.url);
        return originalAjax.apply(this, arguments);
    };

    $('#admin_daterange_collection').val('all');
    $('#admin_daterange_start').val('2025-01-01').trigger('change');
    $('#admin_daterange_end').val('2025-01-01').trigger('change');
    $('.daterangePreviewButton').click();

    var entriesUrl = _.find(capturedUrls, function(u) { return u.indexOf('entries') > -1; });
    var treatmentsUrl = _.find(capturedUrls, function(u) { return u.indexOf('treatments') > -1; });

    var epochMatch = entriesUrl.match(/find\[date\]\[\$gte\]=(\d+)/);
    var isoMatch = treatmentsUrl.match(/find\[created_at\]\[\$gte\]=([^&]+)/);

    var epoch = parseInt(epochMatch[1]);
    var iso = decodeURIComponent(isoMatch[1]);

    // 2025-01-01 in America/New_York starts at 05:00:00 UTC
    var expectedStart = moment.tz('2025-01-01', 'America/New_York').startOf('day');
    epoch.should.equal(expectedStart.valueOf());
    iso.should.equal(expectedStart.toISOString());

    // Check end of day
    var epochEndMatch = entriesUrl.match(/find\[date\]\[\$lte\]=(\d+)/);
    var isoEndMatch = treatmentsUrl.match(/find\[created_at\]\[\$lte\]=([^&]+)/);

    var epochEnd = parseInt(epochEndMatch[1]);
    var isoEnd = decodeURIComponent(isoEndMatch[1]);

    var expectedEnd = moment.tz('2025-01-01', 'America/New_York').endOf('day');
    epochEnd.should.equal(expectedEnd.valueOf());
    isoEnd.should.equal(expectedEnd.toISOString());

    $.ajax = originalAjax;
  });

  it('should delete matching records from all collections with timezone-aware bounds', function() {
    var capturedRequests = [];
    var originalAjax = $.ajax;
    var originalConfirm = window.confirm;
    var originalSetTimeout = global.setTimeout;
    var callbackCalled = false;
    var confirmCalls = 0;

    $.ajax = function(arg1, arg2) {
      var opts = typeof arg1 === 'string' ? arg2 || {} : arg1;
      var url = typeof arg1 === 'string' ? arg1 : opts.url;
      capturedRequests.push({
        method: opts && opts.method ? opts.method : 'GET',
        url: url
      });
      return originalAjax.apply(this, arguments);
    };

    window.confirm = function(message) {
      confirmCalls++;
      should(message).containEql('ALL collections');
      should(message).containEql('2025-01-01');
      should(message).containEql('2025-01-02');
      return true;
    };

    global.setTimeout = function() { return 0; };

    try {
      should(daterangedelete.actions[0].confirmText).equal(undefined);

      $('#admin_daterange_collection').val('all');
      $('#admin_daterange_start').val('2025-01-01');
      $('#admin_daterange_end').val('2025-01-02');

      daterangedelete.actions[0].code(client, function() {
        callbackCalled = true;
      });

      var deleteRequests = capturedRequests.filter(function(req) {
        return req.method === 'DELETE';
      });

      var entriesUrl = _.find(deleteRequests, function(req) {
        return req.url.indexOf('/api/v1/entries/*/') === 0;
      }).url;
      var treatmentsUrl = _.find(deleteRequests, function(req) {
        return req.url.indexOf('/api/v1/treatments/') === 0;
      }).url;
      var devicestatusUrl = _.find(deleteRequests, function(req) {
        return req.url.indexOf('/api/v1/devicestatus/') === 0;
      }).url;

      var expectedStart = moment.tz('2025-01-01', 'America/New_York').startOf('day');
      var expectedEnd = moment.tz('2025-01-02', 'America/New_York').endOf('day');
      var expectedStartIso = encodeURIComponent(expectedStart.toISOString());
      var expectedEndIso = encodeURIComponent(expectedEnd.toISOString());

      callbackCalled.should.equal(true);
      confirmCalls.should.equal(1);
      deleteRequests.length.should.equal(3);

      should(entriesUrl).containEql('find[date][$gte]=' + expectedStart.valueOf());
      should(entriesUrl).containEql('find[date][$lte]=' + expectedEnd.valueOf());
      should(entriesUrl).containEql('count=100000');

      should(treatmentsUrl).containEql('find[created_at][$gte]=' + expectedStartIso);
      should(treatmentsUrl).containEql('find[created_at][$lte]=' + expectedEndIso);
      should(treatmentsUrl).containEql('count=100000');

      should(devicestatusUrl).containEql('find[created_at][$gte]=' + expectedStartIso);
      should(devicestatusUrl).containEql('find[created_at][$lte]=' + expectedEndIso);
      should(devicestatusUrl).containEql('count=100000');
      $('#admin_daterangedelete_0_status').text().should.equal('6 records deleted total');
    } finally {
      $.ajax = originalAjax;
      window.confirm = originalConfirm;
      global.setTimeout = originalSetTimeout;
    }
  });

  it('should reject unexpected collection values', function() {
    var originalAjax = $.ajax;
    var originalAlert = window.alert;
    var originalGlobalAlert = global.alert;
    var ajaxCalled = false;
    var alertMessage = '';
    var callbackCalled = false;

    $.ajax = function() {
      ajaxCalled = true;
      return originalAjax.apply(this, arguments);
    };

    window.alert = function(message) {
      alertMessage = message;
    };
    global.alert = window.alert;

    try {
      $('#admin_daterange_collection').append('<option value="unknown">Unknown</option>').val('unknown');
      $('#admin_daterange_start').val('2025-01-01');
      $('#admin_daterange_end').val('2025-01-02');

      $('.daterangePreviewButton').click();

      ajaxCalled.should.equal(false);
      $('#admin_daterangedelete_info').text().should.equal('Please select a valid collection');

      daterangedelete.actions[0].code(client, function() {
        callbackCalled = true;
      });

      callbackCalled.should.equal(true);
      alertMessage.should.equal('Please select a valid collection');
    } finally {
      $.ajax = originalAjax;
      window.alert = originalAlert;
      global.alert = originalGlobalAlert;
      $('#admin_daterange_collection option[value="unknown"]').remove();
      $('#admin_daterange_collection').val('all');
    }
  });
});
