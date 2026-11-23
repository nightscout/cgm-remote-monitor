'use strict';

function cloneDeep (obj) {
  return JSON.parse(JSON.stringify(obj));
}

function alignProfileWithDefaults (profile, defaults) {
  if (!profile || !defaults) return profile;
  for (var key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)
        && !Object.prototype.hasOwnProperty.call(profile, key)) {
      profile[key] = cloneDeep(defaults[key]);
    }
  }
  for (var pkey in profile) {
    if (Object.prototype.hasOwnProperty.call(profile, pkey)
        && !Object.prototype.hasOwnProperty.call(defaults, pkey)) {
      delete profile[pkey];
    }
  }
  return profile;
}

function coerceToRange (val) {
  if (typeof val !== 'object' || val === null) {
    return [{ time: '00:00', value: val }];
  }
  return val;
}

function convertToRanges (profile, defaults) {
  var mismatch = false;
  if (!profile) return { rangesMismatch: mismatch };

  profile.carbratio   = coerceToRange(profile.carbratio);
  profile.sens        = coerceToRange(profile.sens);
  profile.target_low  = coerceToRange(profile.target_low);
  profile.target_high = coerceToRange(profile.target_high);
  profile.basal       = coerceToRange(profile.basal);

  if (profile.target_high.length !== profile.target_low.length) {
    mismatch = true;
    if (defaults) {
      profile.target_low  = cloneDeep(defaults.target_low);
      profile.target_high = cloneDeep(defaults.target_high);
    }
  }
  return { rangesMismatch: mismatch };
}

function migrateRecordStore (record, defaults) {
  var mismatched = [];
  if (!record || !record.store) return { mismatchedProfiles: mismatched };
  for (var name in record.store) {
    if (!Object.prototype.hasOwnProperty.call(record.store, name)) continue;
    var p = record.store[name];
    alignProfileWithDefaults(p, defaults);
    var res = convertToRanges(p, defaults);
    if (res.rangesMismatch) mismatched.push(name);
  }
  return { mismatchedProfiles: mismatched };
}

module.exports = {
  alignProfileWithDefaults: alignProfileWithDefaults,
  convertToRanges: convertToRanges,
  migrateRecordStore: migrateRecordStore
};
