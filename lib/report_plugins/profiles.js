'use strict';

var profiles = {
  name: 'profiles'
  , label: 'Profiles'
  , pluginType: 'report'
};

function init() {
  return profiles;
}

module.exports = init;

profiles.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h2>' + translate('Profiles') + '</h2>'
    + '<br>' + translate('Database records') + '&nbsp'
    + '<br><select id="profiles-databaserecords"></select>'
    + '<br><span id="profiles-default"></span>'
    + '<div id="profiles-chart">'
    + '</div>'
    ;
  return ret;
};

profiles.css =
    '#profiles-chart {'
  + '  width: 100%;'
  + '  height: 100%;'
  + '}'
  ;

profiles.report = function report_profiles(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;

  var profileRecords = datastorage.profiles;
  var databaseRecords = $('#profiles-databaserecords');

  databaseRecords.empty();
  for (var r = 0; r < profileRecords.length; r++ ) {
    databaseRecords.append('<option value="' + r + '">' + translate('Valid from:') + ' ' + new Date(profileRecords[r].startDate).toLocaleString() + '</option>');
  }
  databaseRecords.unbind().bind('change',recordChange);

  recordChange();

  function recordChange (event) {
    if ($('#profiles-databaserecords option').length < 1)
      return;
    var currentindex = databaseRecords.val();
    var currentrecord = profileRecords[currentindex];

    var table = $('<table border="1">');
    var tr = $('<tr>');

    $('#profiles-default').val(currentrecord.defaultProfile);
    for (var key in currentrecord.store) {
      if (currentrecord.store.hasOwnProperty(key)) {
        tr.append(displayRecord(currentrecord.store[key], key))
      }
    }

    table.append(tr);

    $('#profiles-chart').empty().append(table);

    if (event) {
      event.preventDefault();
    }
  }

  function displayRecord(record, name) {
    var td = $('<td>');
    var table = $('<table>');

    table.append($('<tr>').append($('<td>').append('<b>' + name + '</b>')));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Units') + '</b>:&nbsp' + record.units)));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('DIA') + '</b>:&nbsp' + record.dia)));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Timezone') + '</b>:&nbsp' + record.timezone)));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Carbs activity / absorption rate') + '</b>:&nbsp' + record.carbs_hr)));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Insulin to carb ratio (I:C)') + '</b>:&nbsp' + '<br>' + displayRanges(record.carbratio))));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Insulin Sensitivity Factor (ISF)') + '</b>:&nbsp' + '<br>' + displayRanges(record.sens))));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Basal rates [unit/hour]') + '</b>:&nbsp' + '<br>' + displayRanges(record.basal))));
    table.append($('<tr>').append($('<td>').append('<b>' + translate('Target BG range [mg/dL,mmol/L]') + '</b>:&nbsp' + '<br>' + displayRanges(record.target_low, record.target_high))));

    td.append(table);
    return td;
  }

  function displayRanges(array, array2) {
    var text = '';
    for (var i = 0; i < array.length; i++) {
      text += array[i].time + '&nbsp:&nbsp' + array[i].value + (array2 ? ' - ' + array2[i].value : '') + '<br>';
    }

    return text;
  }
};
