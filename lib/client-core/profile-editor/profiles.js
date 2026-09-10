'use strict';

function cloneDeep (obj) {
  return JSON.parse(JSON.stringify(obj));
}

function uniqueName (store, base) {
  var name = base;
  while (Object.prototype.hasOwnProperty.call(store, name)) {
    name += '1';
  }
  return name;
}

function getFirstAvailableProfile (record, currentName) {
  if (!record || !record.store) return null;
  var available = [];
  for (var key in record.store) {
    if (!Object.prototype.hasOwnProperty.call(record.store, key)) continue;
    if (key !== currentName) available.push(key);
  }
  return available.length ? available[0] : null;
}

function addProfile (record, defaults, baseName) {
  var name = uniqueName(record.store, baseName || 'New profile');
  record.store[name] = cloneDeep(defaults);
  return { record: record, currentProfile: name };
}

function removeProfile (record, currentName) {
  var next = getFirstAvailableProfile(record, currentName);
  if (!next) {
    return { record: record, currentProfile: currentName, removed: false };
  }
  delete record.store[currentName];
  return { record: record, currentProfile: next, removed: true };
}

function cloneProfile (record, currentName, suggestedBase) {
  var base = (suggestedBase || currentName) + ' (copy)';
  var name = uniqueName(record.store, base);
  record.store[name] = cloneDeep(record.store[currentName]);
  return { record: record, currentProfile: name };
}

function renameProfile (record, currentName, newName) {
  if (currentName === newName) {
    return { record: record, currentProfile: currentName, renamed: false };
  }
  var resolved = uniqueName(record.store, newName);
  record.store[resolved] = record.store[currentName];
  delete record.store[currentName];
  return { record: record, currentProfile: resolved, renamed: true };
}

module.exports = {
  uniqueName: uniqueName,
  getFirstAvailableProfile: getFirstAvailableProfile,
  addProfile: addProfile,
  removeProfile: removeProfile,
  cloneProfile: cloneProfile,
  renameProfile: renameProfile
};
