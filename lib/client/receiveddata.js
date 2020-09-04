'use strict';

var _ = require('lodash');

var TWO_DAYS = 172800000;

function mergeDataUpdate(isDelta, cachedDataArray, receivedDataArray, maxAge) {

  function nsArrayDiff(oldArray, newArray) {
    var seen = {};
    var l = oldArray.length;
    
    for (var i = 0; i < l; i++) {
     if (oldArray[i] !== null) {
        seen[oldArray[i].mills] = true;
      }
    }
    
    var result = [];
    l = newArray.length;
    for (var j = 0; j < l; j++) {
      if (!seen.hasOwnProperty(newArray[j].mills)) {
        result.push(newArray[j]); //console.log('delta data found');
      }
    }
    return result;
  }

  // If there was no delta data, just return the original data
  if (!receivedDataArray) {
    return cachedDataArray || [];
  }

  // If this is not a delta update, replace all data
  if (!isDelta) {
    return receivedDataArray || [];
  }

  // purge old data from cache before updating
  var mAge = (isNaN(maxAge) || maxAge == null) ? TWO_DAYS : maxAge;
  var twoDaysAgo = new Date().getTime() - mAge;
    
  for (var i = 0; i < cachedDataArray.length; i++) {
    var element = cachedDataArray[i];
      if (element !== null && element !== undefined && element.mills <= twoDaysAgo) {
        cachedDataArray.splice(i,0);
    }
  }

  // If this is delta, calculate the difference, merge and sort
  var diff = nsArrayDiff(cachedDataArray, receivedDataArray);
  return cachedDataArray.concat(diff).sort(function(a, b) {
    return a.mills - b.mills;
  });
}

function mergeTreatmentUpdate(isDelta, cachedDataArray, receivedDataArray) {

  // If there was no delta data, just return the original data
  if (!receivedDataArray) {
    return cachedDataArray || [];
  }

  // If this is not a delta update, replace all data
  if (!isDelta) {
    return receivedDataArray || [];
  }

  // check for update, change, remove
  var l = receivedDataArray.length;
  var m = cachedDataArray.length;
  for (var i = 0; i < l; i++) {
    var no = receivedDataArray[i];
    if (!no.action) {
      cachedDataArray.push(no);
      continue;
    }
    for (var j = 0; j < m; j++) {
      if (no._id === cachedDataArray[j]._id) {
        if (no.action === 'remove') {
          cachedDataArray.splice(j,1);
          break;
        }
        if (no.action === 'update') {
          delete no.action;
          cachedDataArray.splice(j,1,no);
          break;
        }
      }
    }
  }

  // If this is delta, calculate the difference, merge and sort
  return cachedDataArray.sort(function(a, b) {
    return a.mills - b.mills;
  });
}

function receiveDData (received, ddata, settings) {

  if (!received) {
    return;
  }

  // Calculate the diff to existing data and replace as needed
  ddata.sgvs = mergeDataUpdate(received.delta, ddata.sgvs, received.sgvs);
  ddata.mbgs = mergeDataUpdate(received.delta, ddata.mbgs, received.mbgs);
  ddata.treatments = mergeTreatmentUpdate(received.delta, ddata.treatments, received.treatments);
  ddata.food = mergeTreatmentUpdate(received.delta, ddata.food, received.food);

  ddata.processTreatments(false);

  // Do some reporting on the console
  // console.log('Total SGV data size', ddata.sgvs.length);
  // console.log('Total treatment data size', ddata.treatments.length);

  if (received.cals) {
    ddata.cals = received.cals;
    ddata.cal = _.last(ddata.cals);
  }

  if (received.devicestatus) {
    if (settings.extendedSettings.devicestatus && settings.extendedSettings.devicestatus.advanced) {
      //only use extra memory in advanced mode
      ddata.devicestatus = mergeDataUpdate(received.delta, ddata.devicestatus, received.devicestatus);
    } else {
      ddata.devicestatus = received.devicestatus;
    }
  }

}

//expose for tests
receiveDData.mergeDataUpdate = mergeDataUpdate;
receiveDData.mergeTreatmentUpdate = mergeTreatmentUpdate;

module.exports = receiveDData;
