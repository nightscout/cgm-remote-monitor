'use strict';

var futureitems = {
  name: 'futureitems'
  , label: 'Remove future items from mongo database'
  , pluginType: 'admin'
};

function init() {
  return futureitems;
}

module.exports = init;

futureitems.actions = [
    {
        name: 'Find and remove treatments in the future'
      , description: 'This task find and remove treatments in the future.'
      , buttonLabel: 'Remove treatments in the future'
    }
    , {
        name: 'Find and remove entries in the future'
      , description: 'This task find and remove CGM data in the future created by uploader with wrong date/time.'
      , buttonLabel: 'Remove entries in the future'
    }
  ];

futureitems.actions[0].init = function init(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + futureitems.name + '_0_status');
  
  function valueOrEmpty (value) {
    return value ? value : '';
  }
  
  function showOneTreatment (tr, table) {
    table.append($('<tr>').css('background-color','#0f0f0f')
      .append($('<td>').attr('width','20%').append(new Date(tr.created_at).toLocaleString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3')))
      .append($('<td>').attr('width','20%').append(tr.eventType ? translate(client.careportal.resolveEventName(tr.eventType)) : ''))
      .append($('<td>').attr('width','10%').attr('align','center').append(tr.glucose ? tr.glucose + ' ('+translate(tr.glucoseType)+')' : ''))
      .append($('<td>').attr('width','10%').attr('align','center').append(valueOrEmpty(tr.insulin)))
      .append($('<td>').attr('width','10%').attr('align','center').append(valueOrEmpty(tr.carbs)))
      .append($('<td>').attr('width','10%').append(valueOrEmpty(tr.enteredBy)))
      .append($('<td>').attr('width','20%').append(valueOrEmpty(tr.notes)))
    );
  }
  
  function showTreatments(treatments, table) {
    table.append($('<tr>').css('background','#040404')
      .append($('<th>').css('width','80px').attr('align','left').append(translate('Time')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Event Type')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Blood Glucose')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Insulin')))
      .append($('<th>').css('width','50px').attr('align','left').append(translate('Carbs')))
      .append($('<th>').css('width','150px').attr('align','left').append(translate('Entered By')))
      .append($('<th>').css('width','300px').attr('align','left').append(translate('Notes')))
    );
    for (var t=0; t<treatments.length; t++) {
      showOneTreatment (treatments[t], table);
    }
  };

  $status.hide().text(translate('Loading database ...')).fadeIn('slow');
  var nowiso = new Date().toISOString();
  $.ajax('/api/v1/treatments.json?&find[created_at][$gte]=' + nowiso, {
    headers: client.headers()
    , success: function (records) {
      futureitems.treatmentrecords = records;
      $status.hide().text(translate('Database contains %1 future records',{ params: [records.length] })).fadeIn('slow');
      var table =  $('<table>').css('margin-top','10px');
      $('#admin_' + futureitems.name + '_0_html').append(table);
      showTreatments(records, table);
      futureitems.actions[0].confirmText = translate('Remove %1 selected records?', { params: [records.length] });
    }
    , error: function () {
      $status.hide().text(translate('Error loading database')).fadeIn('slow');
      futureitems.treatmentrecords = [];
    }
  }).done(function () { if (callback) { callback(); } });
};

futureitems.actions[0].code =  function deleteRecords(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + futureitems.name + '_0_status');
  
  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  };

  function deleteRecordById (_id) {
    $.ajax({
        method: 'DELETE'
      , url: '/api/v1/treatments/' + _id
      , headers: client.headers()
    }).done(function success () {
      $status.text(translate('Record %1 removed ...', { params: [_id] }));
    }).fail(function fail() {
      $status.text(translate('Error removing record %1',  { params: [_id] }));
    });
  }
  
  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  for (var i = 0; i < futureitems.treatmentrecords.length; i++) {
    deleteRecordById(futureitems.treatmentrecords[i]._id);
  }
  $('#admin_' + futureitems.name + '_0_html').html('');
  
  if (callback) {
    callback();
  }
};

futureitems.actions[1].init = function init(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + futureitems.name + '_1_status');
  
  $status.hide().text(translate('Loading database ...')).fadeIn('slow');
  var now = new Date().getTime();
  $.ajax('/api/v1/entries.json?&find[date][$gte]=' + now + '&count=288', {
    headers: client.headers()
    , success: function (records) {
      futureitems.entriesrecords = records;
      $status.hide().text(translate('Database contains %1 future records',{ params: [records.length] })).fadeIn('slow');
      futureitems.actions[1].confirmText = translate('Remove %1 selected records?', { params: [records.length] });
    }
    , error: function () {
      $status.hide().text(translate('Error loading database')).fadeIn('slow');
      futureitems.entriesrecords = [];
    }
  }).done(function () { if (callback) { callback(); } });
};

futureitems.actions[1].code =  function deleteRecords(client, callback) {
  var translate = client.translate;
  var $status = $('#admin_' + futureitems.name + '_1_status');
  
  if (!client.hashauth.isAuthenticated()) {
    alert(translate('Your device is not authenticated yet'));
    if (callback) {
      callback();
    }
    return;
  };
  
  function deteleteRecordById (_id) {
    $.ajax({
        method: 'DELETE'
      , url: '/api/v1/entries/' + _id
      , headers: client.headers()
    }).done(function success () {
      $status.text(translate('Record %1 removed ...', { params: [_id] }));
    }).fail(function fail() {
      $status.text(translate('Error removing record %1',  { params: [_id] }));
    });
  }
  

  $status.hide().text(translate('Deleting records ...')).fadeIn('slow');
  for (var i = 0; i < futureitems.entriesrecords.length; i++) {
    deteleteRecordById(futureitems.entriesrecords[i]._id);
  }
  
  if (callback) {
    callback();
  }
};
