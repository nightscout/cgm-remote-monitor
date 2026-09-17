'use strict';

var getDeletedCount = require('./delete-count');

var cleanprofiledb = {
  name: 'cleanprofiledb'
  , label: 'Clean Mongo profile database'
  , pluginType: 'admin'
};

function init() {
  return cleanprofiledb;
}

module.exports = init;

cleanprofiledb.actions = [
    {
        name: 'Delete old profile documents'
      , description: 'This task removes older documents from the profile collection while keeping the newest profile records.'
      , buttonLabel: 'Delete old profile records'
      , confirmText: 'Delete old profile records from profile collection?'
      , preventClose: true
    }
  ];

cleanprofiledb.actions[0].init = function init(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanprofiledb.name + '_0_status');

  $status.hide();

  var keepRecords = '<br/>'
      + '<label for="admin_profile_records_keep">'
      + translate('Profile Records to Keep:')
      + '  <input id="admin_profile_records_keep" value="100" size="3" min="10" max="10000"/>'
      + '</label>';

  $('#admin_' + cleanprofiledb.name + '_0_html').html(keepRecords);

  if (callback) { callback(); }
};

cleanprofiledb.actions[0].code = function deleteOldProfileRecords(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + cleanprofiledb.name + '_0_status');
  var keepRecords = Number($('#admin_profile_records_keep').val());

  if (isNaN(keepRecords) || keepRecords < 10 || keepRecords > 10000 || Math.floor(keepRecords) !== keepRecords) {
    alert(translate('%1 is not a valid number - must be a whole number between 10 and 10000', { params: [$('#admin_profile_records_keep').val()] }));
    if (callback) { callback(); }
    return;
  }

  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  }

  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  $.ajax('/api/v1/profile/?keep=' + keepRecords, {
      method: 'DELETE'
    , headers: client.headers()
    , success: function (retVal) {
      $status.hide().text(translate('%1 records deleted', { params: [getDeletedCount(retVal)] })).fadeIn('slow');
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
