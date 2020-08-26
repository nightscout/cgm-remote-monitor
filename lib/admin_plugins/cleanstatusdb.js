'use strict';

var moment = require('moment');

var cleanstatusdb = {
  name: 'cleanstatusdb'
  , label: 'Clean Mongo status database'
  , pluginType: 'admin'
};

function init () {
  return cleanstatusdb;
}

module.exports = init;

cleanstatusdb.actions = [
  {
    name: 'Delete all documents from devicestatus collection'
    , description: 'This task removes all documents from devicestatus collection. Useful when uploader battery status is not properly updated.'
    , buttonLabel: 'Delete all documents'
    , confirmText: 'Delete all documents from devicestatus collection?'
    }
  , {
    name: 'Delete all documents from devicestatus collection older than 30 days'
    , description: 'This task removes all documents from devicestatus collection that are older than 30 days. Useful when uploader battery status is not properly updated.'
    , buttonLabel: 'Delete old documents'
    , confirmText: 'Delete old documents from devicestatus collection?'
    , preventClose: true
    }
  ];

cleanstatusdb.actions[0].init = function init (client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanstatusdb.name + '_0_status');

  $status.hide().text(translate('Loading database ...')).fadeIn('slow');
  $.ajax('/api/v1/devicestatus.json?count=500', {
    headers: client.headers()
    , success: function(records) {
      var recs = (records.length === 500 ? '500+' : records.length);
      $status.hide().text(translate('Database contains %1 records', { params: [recs] })).fadeIn('slow');
    }
    , error: function() {
      $status.hide().text(translate('Error loading database')).fadeIn('slow');
    }
  }).done(function() { if (callback) { callback(); } });
};

cleanstatusdb.actions[0].code = function deleteRecords (client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanstatusdb.name + '_0_status');

  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  }

  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  $.ajax({
    method: 'DELETE'
    , url: '/api/v1/devicestatus/*'
    , headers: client.headers()
  }).done(function success () {
    $status.hide().text(translate('All records removed ...')).fadeIn('slow');
    if (callback) {
      callback();
    }
  }).fail(function fail () {
    $status.hide().text(translate('Error')).fadeIn('slow');
    if (callback) {
      callback();
    }
  });
};

cleanstatusdb.actions[1].init = function init (client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanstatusdb.name + '_1_status');

  $status.hide();

  var numDays = '<br/>' +
    '<label for="admin_devicestatus_days">' +
    translate('Number of Days to Keep:') +
    '  <input id="admin_devicestatus_days" value="30" size="3" min="1"/>' +
    '</label>';

  $('#admin_' + cleanstatusdb.name + '_1_html').html(numDays);

  if (callback) { callback(); }
};

cleanstatusdb.actions[1].code = function deleteOldRecords (client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanstatusdb.name + '_1_status');
  var numDays = Number($('#admin_devicestatus_days').val());

  if (isNaN(numDays) || (numDays < 1)) {
    alert(translate('%1 is not a valid number', { params: [$('#admin_devicestatus_days').val()] }));
    if (callback) { callback(); }
    return;
  }
  var endDate = moment().subtract(numDays, 'days');
  var dateStr = endDate.format('YYYY-MM-DD');

  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  }

  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  $.ajax('/api/v1/devicestatus/?find[created_at][$lte]=' + dateStr, {
    method: 'DELETE'
    , headers: client.headers()
    , success: function(retVal) {
      $status.text(translate('%1 records deleted', { params: [retVal.n] }));
    }
    , error: function() {
      $status.hide().text(translate('Error')).fadeIn('slow');
    }
  }).done(function success () {
    if (callback) { callback(); }
  }).fail(function fail () {
    if (callback) { callback(); }
  });
};
