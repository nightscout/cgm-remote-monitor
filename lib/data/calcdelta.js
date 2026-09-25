'use strict';

var isDeepStrictEqual = require('node:util').isDeepStrictEqual;


module.exports = function calcDelta (oldData, newData) {

  var delta = {'delta': true};
  var changesFound = false;

  // if there's no updates done so far, just return the full set
  if (!oldData.sgvs) { return newData; }

  function nsArrayTreatments(oldArray, newArray) {
    var result = [];

    var l = newArray.length;
    var m = oldArray.length;
    var found, founddiff, no, oo, i, j;

    // Index both sides by _id once instead of rescanning the opposite array for
    // every element. Both loops below were lookups by _id that stopped at the
    // first match, so a map keyed on first occurrence answers them identically
    // while preserving the order results are pushed in.
    var oldById = new Map();
    for (j = 0; j < m; j++) {
      oo = oldArray[j];
      oo._id = oo._id.toString();
      if (!oldById.has(oo._id)) { oldById.set(oo._id, oo); }
    }
    var newIds = new Set();
    for (i = 0; i < l; i++) {
      no = newArray[i];
      no._id = no._id.toString();
      newIds.add(no._id);
    }

    // check for add, change
    for (i = 0; i < l; i++) {
      no = newArray[i];
      founddiff = false;
      oo = oldById.get(no._id);
      found = oo !== undefined;
      if (found) {
        var oo_copy = { ...oo };
        var no_copy = { ...no };
        delete oo_copy.mgdl;
        delete no_copy.mgdl;
        if (!isDeepStrictEqual(oo_copy, no_copy)) {
          founddiff = true;
        }
      }
      if (founddiff) {
        // Create a shallow copy using the spread operator
        var nno = { ...no };
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
      if (!newIds.has(oo._id)) {
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
          if (!isDeepStrictEqual(newData[o], oldData[o])) {
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
