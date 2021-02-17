'use strict';

var _ = require('lodash');

module.exports = function calcDelta (oldData, newData) {

  var delta = {'delta': true};
  var changesFound = false;

  // if there's no updates done so far, just return the full set
  if (!oldData.sgvs) { return newData; }

  function nsArrayTreatments(oldArray, newArray) {
    var result = [];

    // check for add, change
    var l = newArray.length;
    var m = oldArray.length;
    var found, founddiff, no, oo, i, j;
    for (i = 0; i < l; i++) {
      no = newArray[i];
      no._id = no._id.toString();
      found = false;
      founddiff = false;
      for (j = 0; j < m; j++) {
        oo = oldArray[j];
        oo._id = oo._id.toString();
        if (no._id === oo._id) {
          found = true;
          var oo_copy = _.clone(oo);
          var no_copy = _.clone(no);
          delete oo_copy.mgdl;
          delete no_copy.mgdl;
          if (!_.isEqual(oo_copy, no_copy)) {
            founddiff = true;
          }
          break;
        }
      }
      if (founddiff) {
        var nno = _.clone(no);
        nno.action = 'update';
        result.push(nno);
      }
      if (!found) {
        result.push(no);
      }
    }

    //check for delete
    for (j = 0; j < m; j++) {
      oo = oldArray[j];
      found = false;
      for (i = 0; i < l; i++) {
        no = newArray[i];
        if (no._id === oo._id) {
          found = true;
          break;
        }
      }
      if (!found) {
        result.push({ _id: oo._id, mills: oo.mills, action: 'remove' });
      }
    }

    return result;
  }

  function genKey(o) {
    let r = o.mills;
    r += o.sgv ? 'sgv' + o.sgv : '';
    r += o.mgdl ? 'sgv' + o.mgdl : '';
    return r;
  }

  function nsArrayDiff(oldArray, newArray) {
    var seen = {};
    var l = oldArray.length;
    for (var i = 0; i < l; i++) {
      seen[genKey(oldArray[i])] = true;
    }
    var result = [];
    l = newArray.length;
    for (var j = 0; j < l; j++) {
      if (!Object.prototype.hasOwnProperty.call(seen, genKey(newArray[j]))) {
        result.push(newArray[j]);
      }
    }
    return result;
  }

  function sort(values) {
    values.sort(function sorter(a, b) {
      return a.mills - b.mills;
    });
  }

  function compressArrays(delta, newData) {
    // array compression
    var compressibleArrays = ['sgvs', 'treatments', 'mbgs', 'cals', 'devicestatus'];
    var changesFound = false;

    for (var array in compressibleArrays) {
      if (Object.prototype.hasOwnProperty.call(compressibleArrays, array)) {
        var a = compressibleArrays[array];
        if (Object.prototype.hasOwnProperty.call(newData, a)) {

          // if previous data doesn't have the property (first time delta?), just assign data over
          if (!Object.prototype.hasOwnProperty.call(oldData, a)) {
            delta[a] = newData[a];
            changesFound = true;
            continue;
          }

          // Calculate delta and assign delta over if changes were found
          var deltaData = (a === 'treatments' ? nsArrayTreatments(oldData[a], newData[a]) : nsArrayDiff(oldData[a], newData[a]));
          if (deltaData.length > 0) {
            //console.log('delta changes found on', a);
            changesFound = true;
            sort(deltaData);
            delta[a] = deltaData;
          }
        }
      }
    }
    return {'delta': delta, 'changesFound': changesFound};
  }

  function deleteSkippables(delta,newData) {
    // objects
    var skippableObjects = ['profiles'];
    var changesFound = false;

    for (var object in skippableObjects) {
      if (Object.prototype.hasOwnProperty.call(skippableObjects, object)) {
        var o = skippableObjects[object];
        if (Object.prototype.hasOwnProperty.call(newData, o)) {
          if (JSON.stringify(newData[o]) !== JSON.stringify(oldData[o])) {
            //console.log('delta changes found on', o);
            changesFound = true;
            delta[o] = newData[o];
          }
        }
      }
    }
    return {'delta': delta, 'changesFound': changesFound};
  }

  delta.lastUpdated = newData.lastUpdated;

  var compressedDelta = compressArrays(delta, newData);
  delta = compressedDelta.delta;
  if (compressedDelta.changesFound) { changesFound = true; }

  var skippedDelta = deleteSkippables(delta, newData);
  delta = skippedDelta.delta;
  if (skippedDelta.changesFound) { changesFound = true; }

  if (changesFound) { return delta; }
  return newData;

};
