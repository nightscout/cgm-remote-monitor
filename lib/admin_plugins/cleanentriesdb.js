'use strict';

var moment = require('moment');

var cleanentriesdb = {
  name: 'cleanentriesdb'
  , label: 'Clean Mongo entries (glucose entries) database'
  , pluginType: 'admin'
};

function init() {
  return cleanentriesdb;
}

module.exports = init;

cleanentriesdb.actions = [
    {
        name: 'Delete all documents from entries collection older than 180 days'
      , description: 'This task removes all documents from entries collection that are older than 180 days. Useful when uploader battery status is not properly updated.'
      , buttonLabel: 'Delete old documents'
      , confirmText: 'Delete old documents from entries collection?'
      , preventClose: true
    }
  ];

cleanentriesdb.actions[0].init = function init(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanentriesdb.name + '_0_status');

  $status.hide();

  var numDays =  '<br/>'
      + '<label for="admin_entries_days">'
      + translate('Number of Days to Keep:')
      + '  <input id="admin_entries_days" value="180" size="3" min="1"/>'
      + '</label>';

  $('#admin_' + cleanentriesdb.name + '_0_html').html(numDays);

  if (callback) { callback(); }
};

cleanentriesdb.actions[0].code =  function deleteOldRecords(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanentriesdb.name + '_0_status');
  var numDays = Number($('#admin_entries_days').val());

  if (isNaN(numDays) || (numDays < 3)) {
    alert(translate('%1 is not a valid number - must be more than 2', { params: [$('#admin_entries_days').val()] }));
    if (callback) { callback(); }
    return;
  }
  var endDate = moment().subtract(numDays, 'days');

  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  }

  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  $.ajax('/api/v1/entries/?find[date][$lte]=' + endDate.valueOf(), {
      method: 'DELETE'
    , headers: client.headers()
    , success: function (retVal) {
      $status.hide().text(translate('%1 records deleted',{ params: [retVal.n] })).fadeIn('slow');
    }
    , error: function () {
      $status.hide().text(translate('Error')).fadeIn('slow');
    }
  }).done(function success () {
    if (callback) { callback(); }
  }).fail(function fail() {
    if (callback) { callback(); }
  });

};
