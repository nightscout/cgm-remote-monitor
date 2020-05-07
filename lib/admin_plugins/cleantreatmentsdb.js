'use strict';

var moment = require('moment');

var cleantreatmentsdb = {
  name: 'cleantreatmentsdb'
  , label: 'Clean Mongo treatments database'
  , pluginType: 'admin'
};

function init() {
  return cleantreatmentsdb;
}

module.exports = init;

cleantreatmentsdb.actions = [
    {
        name: 'Delete all documents from treatments collection older than 180 days'
      , description: 'This task removes all documents from treatments collection that are older than 180 days. Useful when uploader battery status is not properly updated.'
      , buttonLabel: 'Delete old documents'
      , confirmText: 'Delete old documents from treatments collection?'
      , preventClose: true
    }
  ];

cleantreatmentsdb.actions[0].init = function init(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleantreatmentsdb.name + '_0_status');

  $status.hide();

  var numDays =  '<br/>'
      + '<label for="admin_treatments_days">'
      + translate('Number of Days to Keep:')
      + '  <input id="admin_treatments_days" value="180" size="3" min="1"/>'
      + '</label>';

  $('#admin_' + cleantreatmentsdb.name + '_0_html').html(numDays);

  if (callback) { callback(); }
};

cleantreatmentsdb.actions[0].code =  function deleteOldRecords(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleantreatmentsdb.name + '_0_status');
  var numDays = Number($('#admin_treatments_days').val());

  if (isNaN(numDays) || (numDays < 3)) {
    alert(translate('%1 is not a valid number - must be more than 2', { params: [$('#admin_treatments_days').val()] }));
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
  $.ajax('/api/v1/treatments/?find[created_at][$lte]=' + dateStr, {
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
