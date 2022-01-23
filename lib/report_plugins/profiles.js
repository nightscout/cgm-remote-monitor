'use strict';

var profiles = {
  name: 'profiles'
  , label: 'Profiles'
  , pluginType: 'report'
};

function init () {
  return profiles;
}

module.exports = init;

profiles.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Profiles') + '</h2>' +
    '<br>' + translate('Database records') + '&nbsp' +
    // '<br><select id="profiles-databaserecords"></select>' +
    '<br><span id="profiles-default"></span>' +
    '<div id="profiles-chart">' +
    '</div>';
  return ret;
};

profiles.css =
  '#profiles-chart {' +
  '  width: 100%;' +
  '  height: 100%;' +
  '}';

profiles.report = function report_profiles (datastorage) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;

  var profileRecords = datastorage.profiles;
  // var databaseRecords = $('#profiles-databaserecords');

  // databaseRecords.empty();
  // for (var r = 0; r < profileRecords.length; r++) {
  //   databaseRecords.append('<option value="' + r + '">' + translate('Valid from:') + ' ' + new Date(profileRecords[r].startDate).toLocaleString() + '</option>');
  // }
  // databaseRecords.unbind().bind('change', recordChange);

  recordChange();

  function recordChange (event) {
    // if ($('#profiles-databaserecords option').length < 1)
    //   return;
    // var currentindex = databaseRecords.val(); 
    var currentrecord = profileRecords[0];

    var div = $('<div style="max-height:700px; overflow-y:auto; display: inline-block; max-width: 1500px; overflow-x:auto; ">')
    var table = $('<table border="1">');
    
    $('#profiles-default').val(currentrecord.defaultProfile);

    profileRecords.forEach(profileR => {
      var tr = $('<tr>');
      var pName = profileR.defaultProfile;
      if(!pName.includes("@@@@")){
        var profileDate = new Date(profileR.startDate);
        var p = currentrecord.store[pName];
        tr.append(displayRecord(p, pName, profileDate.toLocaleDateString() + " " + profileDate.toLocaleTimeString()));
        
      }
      table.append(tr);
    });
    // Object.keys(currentrecord.store).reverse().forEach(key => {
    //   var tr = $('<tr>');
    //   if(!key.includes("@@@@")){
    //     var profileDate = new Date(currentrecord.startDate);
    //     var p = currentrecord.store[key];
    //     tr.append(displayRecord(p, key, profileDate.toLocaleDateString() + " " + profileDate.toLocaleTimeString()));
        
    //     profileRecords.forEach(snapshot => {
    //       var profileDate2 = new Date(snapshot.startDate);
    //       if(profileDate2 != profileDate){
    //         Object.keys(snapshot.store).reverse().forEach(key2 => {
    //           var p2 = snapshot.store[key2];
    //           if(key2 === key && (p2.dia != p.dia || !compareRanges(p2.carbratio, p.carbratio) || !compareRanges(p2.basal, p.basal) || !compareRanges(p2.sens, p.sens) || !compareRanges(p2.target_high, p.target_high) || !compareRanges(p2.target_low, p.target_low))){
    //             tr.append(displayRecord(snapshot.store[key2], key2, profileDate2.toLocaleDateString() + " " + profileDate2.toLocaleTimeString()));
    //           }
    //         });
    //       }  
    //     });
    //     table.append(tr);
    //   }
    // });

    
    div.append(table);

    $('#profiles-chart').empty().append(div);

    if (event) {
      event.preventDefault();
    }
  }
  function compareRanges (a1, a2){
    console.log("hh: " + a1.every((n, i) => n.value === a2[i].value));
    return a1.length === a2.length && a1.every((n, i) => n.value === a2[i].value);
  }

  function displayRecord (record, name, startdate) {
    var td = $('<td style="vertical-align: top;">');
    var table = $('<table>');

    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + name + '</b>')));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>Startdate</b>:<br>' + startdate)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Units') + '</b>:&nbsp' + record.units)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('DIA') + '</b>:&nbsp' + record.dia)));
    //table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Timezone') + '</b>:&nbsp' + record.timezone)));
    //table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Carbs activity / absorption rate') + '</b>:&nbsp' + record.carbs_hr)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('I:C') + '</b>:&nbsp' + '<br>' + displayRanges(record.carbratio))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('ISF') + '</b>:&nbsp' + '<br>' + displayRanges(record.sens))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Basal rates') + '</b>:&nbsp' + '<br>' + displayBasalRanges(record.basal))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Target BG') + '</b>:&nbsp' + '<br>' + displayRanges(record.target_low, record.target_high))));

    td.append(table);
    return td;
  }


  function displayRanges (array, array2) {
    var text = '';

    if (array && array2) {
      for (let i = 0; i < array.length; i++) {
        text += array[i].time + '&nbsp:&nbsp' + array[i].value + (array2 ? ' - ' + array2[i].value : '') + '<br>';
      }
    } else {
      for (let i = 0; i < array.length; i++) {
        text += array[i].time + '&nbsp:&nbsp' + array[i].value  + '<br>';
      }
    }
    return text;
  }

  function displayBasalRanges (array) {
    var text = '';
    var t=0;
    for (let i = 0; i < array.length; i++) {
      while(parseInt(array[i].time.substring(0,2)) > t){
        text += "<br>";
        t=t+1;
      }
      text += array[i].time + '&nbsp:&nbsp' + array[i].value  + '<br>';
      t=t+1;
    }
    while(t<24){
      text += '<br>';
      t=t+1;
    }
    return text;
  }
};
