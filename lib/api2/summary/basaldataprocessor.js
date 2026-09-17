const { data } = require("jquery");

const dataProcessor = {};

function _hhmmAfter (hhmm, mills) {
  var date = new Date(mills);
  var withSameDate = new Date(
    1900 + date.getYear()
    , date.getMonth()
    , date.getDate()
    , parseInt(hhmm.substr(0, 2), 10)
    , parseInt(hhmm.substr(3, 5), 10)
  ).getTime();
  return withSameDate > date ? withSameDate : withSameDate + 24 * 60 * 60 * 1000;
}

// Outputs temp basal objects describing the profile temps for the duration
function _profileBasalsInWindow (basals, start, end) {
  if (basals.length === 0) {
    return [];
  }

  var i;
  var out = [];

  function nextProfileBasal () {
    i = (i + 1) % basals.length;
    var lastStart = out[out.length - 1].start;
    return {
      start: _hhmmAfter(basals[i]['time'], lastStart)
      , absolute: parseFloat(basals[i]['value'])
      , profile: 1
     };
  }

  i = 0;
  var startHHMM = new Date(start).toTimeString().substr(0, 5);
  while (i < basals.length - 1 && basals[i + 1]['time'] <= startHHMM) {
    i++;
  }
  out.push({
    start: start
    , absolute: parseFloat(basals[i]['value'])
  , });

  var next = nextProfileBasal();
  while (next.start < end) {
    out.push(next);
    next = nextProfileBasal();
  }

  return out;
}

dataProcessor.filterSameAbsTemps = function filterSameAbsTemps (tempdata) {

  var out = [];
  var j = 0;

  for (let i = 0; i < tempdata.length; i++) {
    const temp = tempdata[i];

    if (i == tempdata.length - 1) {
      // If last was merged, skip
      if (j != i) {
        out.push(temp);
      }
      break;
    }

    const nextTemp = tempdata[i + 1];

    if (temp.duration && (temp.start + temp.duration) >= nextTemp.start) {
      if (temp.absolute == nextTemp.absolute) {
        // Merge and skip next
        temp.duration = nextTemp.start - temp.start + nextTemp.duration;
        i += 1;
        j = i;
      } else {
        // Adjust duration
        temp.duration = nextTemp.start - temp.start;
      }
    }
    out.push(temp);
  }
  return out;
}

dataProcessor.processTempBasals = function processTempBasals (profile, tempBasals, dataCap) {
  var profileBasals = profile.basal;
  var temps = tempBasals.map(function(temp) {
    return {
      start: new Date(temp['created_at']).getTime()
      , duration: temp['duration'] === undefined ? 0 : parseInt(temp['duration'], 10) * 60 * 1000
      , absolute: temp['absolute'] === undefined ? 0 : parseFloat(temp['absolute'])
    };
  }).concat([
    { start: Date.now() - 24 * 60 * 60 * 1000, duration: 0 }
    , { start: Date.now(), duration: 0}
    ]).sort(function(a, b) {
    return a.start - b.start;
  });

  var out = [];
  temps.forEach(function(temp) {
    var last = out[out.length - 1];
    if (last && last.duration !== undefined && last.start + last.duration < temp.start) {
      Array.prototype.push.apply(out, _profileBasalsInWindow(profileBasals, last.start + last.duration, temp.start));
    }
    if (temp.duration) out.push(temp);
  });

  var o2 = out;
  var prevLength = 1;
  var newLength = 0;

  while (prevLength != newLength) {
    prevLength = o2.length;
    o2 = dataProcessor.filterSameAbsTemps(o2);
    newLength = o2.length;
  }

  var o3 = [];
 
  // Return temps from last hours
  for (var i = 0; i < o2.length; i++) {
    if ((o2[i].start + o2[i].duration) > dataCap) o3.push(o2[i]);
  }

  // Convert durations to seconds

  for (var i = 0; i < o3.length; i++) {
    o3[i].duration = o3[i].duration / 1000;
  }

  return o3;
}

module.exports = dataProcessor;
