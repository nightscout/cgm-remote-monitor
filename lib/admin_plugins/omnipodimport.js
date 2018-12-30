'use strict';

var omnipodimport = {
  name: 'omnipodimport'
  , label: 'Import data from an Omnipod PDM file'
  , pluginType: 'admin'
};

function init() {
  return omnipodimport;
}

module.exports = init;

omnipodimport.actions = [{
  name: 'Upload carb and bolus entries'
  , description: 'This task will read an Omnipod PDM export file and import the Carb and Bolus entries.'
  , buttonLabel: 'Upload an Omnipod PDM export file.'
  , preventClose: true
}];

omnipodimport.actions[0].ids = {
  fileInputID: 'admin_' + omnipodimport.name + '_0_ibf'
  , timeOffsetID: 'admin_' + omnipodimport.name + '_0_timeOffset'
}

omnipodimport.actions[0].init = function uploadOmnipodInit() {
  var $div = $('#admin_' + omnipodimport.name + '_0_html');

  var form = $('<form>').attr('ID', 'ibfForm');
  $div.append($('<br>'), form);

  var fileInputLabel = $('<label>')
    .attr('for', '#' + omnipodimport.actions[0].ids.fileInputID)
    .text('IBF file:');
  var fileInput = $('<input>')
    .attr('id', omnipodimport.actions[0].ids.fileInputID)
    .attr('name', 'ibf')
    .attr('type', 'file')
    .attr('accept', '.ibf');

  var timeOffsetLabel = $('<label>')
    .attr('for', '#' + omnipodimport.actions[0].ids.timeOffsetID)
    .text('Timezone offset (eg "-8" for "UTC-8:00"):');

  var defaultTimeOffset = -1 * new Date().getTimezoneOffset() / 60.0;
  var timeOffset = $('<input>')
    .attr('id', omnipodimport.actions[0].ids.timeOffsetID)
    .attr('name', 'tzOffset')
    .attr('type', 'number')
    .attr('step', 'any')
    .attr('min', -12)
    .attr('max', 14)
    .attr('value', defaultTimeOffset);

  form.append(
    fileInputLabel
    , fileInput
    , $('<br>')
    , timeOffsetLabel
    , timeOffset);
}

omnipodimport.actions[0].code = function uploadOmnipod(client, callback) {
  var $status = $('#admin_' + omnipodimport.name + '_0_status');
  var apisecrethash = localStorage.getItem('apisecrethash');

  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  };

  $status.hide().text('Uploading...').fadeIn('slow');

  var data = new FormData();
  data.append('tzOffset', $('#' + omnipodimport.actions[0].ids.timeOffsetID).val());
  data.append('idf', $('#' + omnipodimport.actions[0].ids.fileInputID).prop('files')[0]);

  $.ajax({
    method: 'POST',
    url: '/upload/omnipod',
    data: data,
    beforeSend: function beforeSend(xhr) {
      xhr.setRequestHeader('api-secret', apisecrethash);
    },
    contentType: false,
    processData: false,
    success: function success() {
      $status.hide().text('Upload complete!').fadeIn('slow');
    }
  });

  if (callback) {
    callback();
  }
}
