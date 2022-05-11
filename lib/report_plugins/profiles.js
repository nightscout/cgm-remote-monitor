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

profiles.report = function report_profiles(datastorage) {
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

  function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;

    // If you don't care about the order of the elements inside
    // the array, you should sort both arrays here.
    // Please note that calling sort on an array will modify that array.
    // you might want to clone your array first.

    for (var i = 0; i < a.length; ++i) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function recordChange(event) {
    // if ($('#profiles-databaserecords option').length < 1)
    //   return;
    // var currentindex = databaseRecords.val(); 
    var currentrecord = profileRecords.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    var div = $('<div style="display: inline-block; max-width: 1500px; overflow-x:auto; ">')
    var table = $('<table border="0">');

    $('#profiles-default').val(currentrecord.defaultProfile);
    var tr = $('<tr style="border: solid 1px">');

    var lastP = null;
    var first = true;
    var lastProfDate = new Date();
    profileRecords.reverse().forEach(profile => {
      let pName = profile.defaultProfile;
      var td = $('<td style="border-right: solid 1px; vertical-align: top;">');
      if (!pName.includes("@@@@")) {
        var profileDate = new Date(profile.startDate);
        if (profileDate.getTime() == lastProfDate.getTime()) {
          return;
        }
        lastProfDate = profileDate;
        var p = profile.store[pName];
        //skip if douplicate:
        if (!first
          && p.dia === lastP.dia
          && arraysEqual(p.carbratio, lastP.carbratio)
          && arraysEqual(p.sens, lastP.sens)
          && arraysEqual(p.basal, lastP.basal)
          && arraysEqual(p.target_high, lastP.target_high)
          && arraysEqual(p.target_low, lastP.target_low)
        ) {
          return;
        }
        td.append(displayRecord(p, pName, profileDate.toLocaleDateString(), profileDate.toLocaleTimeString(), lastP));
        lastP = p;
        first = false;
      }
      tr.prepend(td);
    });
    table.append(tr);

    div.append(table);

    $('#profiles-chart').empty().append(div);

    if (event) {
      event.preventDefault();
    }
  }
  function compareRanges(a1, a2) {
    console.log("hh: " + a1.every((n, i) => n.value === a2[i].value));
    return a1.length === a2.length && a1.every((n, i) => n.value === a2[i].value);
  }

  function displayRecord(record, name, starDate, startTIme, lastRecord) {
    var td = $('<td style="vertical-align: top;">');
    var table = $('<table>');

    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + name + '</b>')));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>Startdate</b>:<br>' + starDate + '<br>' + startTIme)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Units') + '</b>:&nbsp' + record.units)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('DIA') + '</b>:&nbsp' + record.dia)));
    //table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Timezone') + '</b>:&nbsp' + record.timezone)));
    //table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Carbs activity / absorption rate') + '</b>:&nbsp' + record.carbs_hr)));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('I:C') + '</b>:&nbsp' + '<br>' + displayRanges(record.carbratio, lastRecord?.carbratio))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('ISF') + '</b>:&nbsp' + '<br>' + displayRanges(record.sens, lastRecord?.sens))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Basal rates') + '</b>:&nbsp' + '<br>' + displayBasalRanges(record.basal, lastRecord?.basal))));
    table.append($('<tr>').append($('<td style="white-space:nowrap;">').append('<b>' + translate('Target BG') + '</b>:&nbsp' + '<br>' + displayTargetRanges(record.target_low, record.target_high, lastRecord?.target_low, lastRecord?.target_high))));

    td.append(table);
    return td;
  }


  function displayRanges(a1, a2) {
    var text = '';
    let maxI = (a2 != null ? Math.max(a1.length, a2.length) : a1.length);
    if (a2 == null) { //first profile
      for (let i = 0; i < maxI; i++) {
        text += a1[i].time + '&nbsp:&nbsp' + a1[i].value + '<br>';
      }
    } else {
      for (let h = 0; h < 24; h++) {
        let T1 = valueFromHour(a1, h);
        let T2 = valueFromHour(a2, h);
        if (!T1 && !T2) {
        } else if (!T1) {
          text += '<div style="border-radius:5px; background-color:Coral">|</div><br>';
        } else if (!T2) {
          text += '<div style="border-radius:5px; background-color:lightgreen">' + T1.time + '&nbsp:&nbsp' + T1.value + '</div><br>';
        } else if (T1.value != T2.value) {
          text += '<div style="border-radius:5px; background-color:yellow">' + T1.time + '&nbsp:&nbsp' + T1.value + '</div>';
        }else {
          text += T1.time + '&nbsp:&nbsp' + T1.value + '<br>';
        }
      }
    }
    return text;
  }


  function displayTargetRanges(a1, a1_2, a2, a2_2) {
    var text = '';
    let maxI = (a2 != null ? Math.max(a1.length, a2.length) : a1.length);
    if (a2 == null) { //first profile
      for (let i = 0; i < maxI; i++) {
        text += a1[i].time + '&nbsp:&nbsp' + a1[i].value + (a1_2 && a1_2.value != a1.value ? ' - ' + a1_2[i].value : '') + '<br>';
      }
    } else {
      for (let h = 0; h < 24; h++) {

        let T1 = valueFromHour(a1, h);
        let T2 = valueFromHour(a2, h);
        let T1_2 = valueFromHour(a1_2, h);
        if (!T1 && !T2) {
        } else if (!T1) {
          text += '<div style="border-radius:5px; background-color:Coral">|</div><br>';
        } else if (!T2) {
          text += '<div style="border-radius:5px; background-color:lightgreen">' + T1.time + '&nbsp:&nbsp' + T1_1.value + (T1_2 && T1_2.value != T1.value ? ' - ' + T1_2.value : '') + '</div><br>';
        } else {
          text += T1.time + '&nbsp:&nbsp' + T1_2.value + (T1_2 && T1_2.value != T1.value ? ' - ' + T1_2.value : '') + '<br>';
        }


      }
    }


    return text;
  }
  function valueFromHour(ar, h) {
    var found;
    ar.forEach(it => {
      if (!found && parseInt(it.time.substring(0, 2)) == h) {
        found = it;
        return
      }
    })
    return found;
  }

  function displayBasalRanges(a1, a2) {
    var text = '';

    var i = 0;
    for (let h = 0; h < 24; h++) {
      if (a2 == null) {
        if (i < a1.length && (a1[i].time.substring(0, 2)) == h) {
          text += a1[i].time + '&nbsp:&nbsp' + a1[i].value.toFixed(2) + '<br>';
          i++;
        } else {
          text += String(h).padStart(2, '0') + ':00&nbsp:&nbsp|<br>';
        }
      } else {
        let b1 = valueFromHour(a1, h);
        let b2 = valueFromHour(a2, h);
        if (!b1 && !b2) {
          text += String(h).padStart(2, '0') + ':00&nbsp:&nbsp|<br>';
        } else if (!b1) {
          text += '<div style="border-radius:5px; background-color:Coral">' + String(h).padStart(2, '0') + ':00&nbsp:&nbsp|</div>';
        } else if (!b2) {
          text += '<div style="border-radius:5px; background-color:lightgreen">' + b1.time + '&nbsp:&nbsp' + b1.value.toFixed(2) + '</div>';
        } else if (b1.value != b2.value) {
          text += '<div style="border-radius:5px; background-color:yellow">' + b1.time + '&nbsp:&nbsp' + b1.value.toFixed(2) + '</div>';
        } else if (b1.value == b2.value) {
          text += b1.time + '&nbsp:&nbsp' + b1.value.toFixed(2) + '<br>';
        } else {
          text += String(h).padStart(2, '0') + ':00&nbsp:&nbsp|<br>';
        }
      }
    }
    return text;
  }
};
