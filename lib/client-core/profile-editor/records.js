'use strict';

function cloneDeep (obj) {
  return JSON.parse(JSON.stringify(obj));
}

function newEmptyRecord (defaults) {
  return {
    startDate: new Date().toISOString(),
    defaultProfile: 'Default',
    store: { 'Default': cloneDeep(defaults) }
  };
}

function addRecord (records, defaults) {
  records.push(newEmptyRecord(defaults));
  return {
    records: records,
    currentIndex: records.length - 1,
    currentProfile: 'Default'
  };
}

function removeRecord (records, currentIndex) {
  if (records.length <= 1) {
    return { records: records, currentIndex: currentIndex, removed: false };
  }
  records.splice(currentIndex, 1);
  var nextIndex = 0;
  return {
    records: records,
    currentIndex: nextIndex,
    currentProfile: records[nextIndex].defaultProfile,
    removed: true
  };
}

var STRIP_KEYS = ['_id', 'srvModified', 'srvCreated', 'identifier', 'mills'];

function omitKeys (obj, keys) {
  var out = {};
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    if (keys.indexOf(k) !== -1) continue;
    out[k] = obj[k];
  }
  return out;
}

function cloneRecord (records, currentIndex) {
  var clone = omitKeys(records[currentIndex], STRIP_KEYS);
  clone.startDate = new Date().toISOString();
  records.push(clone);
  var nextIndex = records.length - 1;
  return {
    records: records,
    currentIndex: nextIndex,
    currentProfile: clone.defaultProfile
  };
}

module.exports = {
  newEmptyRecord: newEmptyRecord,
  addRecord: addRecord,
  removeRecord: removeRecord,
  cloneRecord: cloneRecord,
  STRIP_KEYS: STRIP_KEYS
};
