'use strict';

const assert = require('node:assert/strict');

// Source-derived synthetic patterns, not execution of either Swift application.
// Pins match workspace.lock.json in the alignment workspace. No external checkout
// or private export is needed at test runtime. API3 history is a server acceptance
// check appended to the legacy workflow; neither pinned client is claimed to use it.
const sources = Object.freeze({
  nightscoutKit: {
    repository: 'https://github.com/LoopKit/NightscoutKit',
    revision: '4ec9fd12a16b5d6c2de4f11870511361d42e1b7f',
    paths: ['Sources/NightscoutKit/NightscoutClient.swift',
      'Sources/NightscoutKit/Models/GlucoseEntry.swift',
      'Sources/NightscoutKit/Models/DeviceStatus.swift',
      'Sources/NightscoutKit/Models/Treatments/NightscoutTreatment.swift',
      'Sources/NightscoutKit/Models/Treatments/CarbCorrectionNightscoutTreatment.swift',
      'Sources/NightscoutKit/Models/ProfileSet.swift']
  },
  loopFollow: {
    repository: 'https://github.com/loopandlearn/LoopFollow',
    revision: '4a74b781ad6836dd77eccc03bb08a42749dd59a6',
    paths: ['LoopFollow/Helpers/NightscoutUtils.swift',
      ...['BGData', 'Treatments', 'DeviceStatus', 'Profile'].map(name =>
        'LoopFollow/Controllers/Nightscout/' + name + '.swift')]
  }
});
const BASE = 1793664000000;
const iso = offset => new Date(BASE + offset).toISOString();
const schedule = value => [{ time: '00:00', timeAsSeconds: 0, value }];

function documents (tenant = 0) {
  return {
    // The uploader has not yet received server IDs. Resend these exact payloads.
    entries: [0, 300000].map(offset => ({ date: BASE + offset, dateString: iso(offset),
      device: 'loop://synthetic', type: 'sgv', sgv: 120 + tenant * 80 + offset / 300000,
      direction: 'Flat', trend: 4, trendRate: 0, isCalibration: false })),
    treatments: [{ created_at: iso(0), timestamp: iso(0), enteredBy: 'synthetic-loop',
      eventType: 'Carb Correction', carbs: 12 + tenant, absorptionTime: 180,
      syncIdentifier: 'synthetic-shared-sync', notes: 'synthetic meal' }],
    devicestatus: [{ device: 'loop://synthetic', created_at: iso(0),
      identifier: 'synthetic-shared-device', uploader: { name: 'synthetic', timestamp: iso(0), battery: 70 + tenant },
      loop: { name: 'Loop', version: 'synthetic', timestamp: iso(0),
        iob: { timestamp: iso(0), iob: 1 + tenant },
        predicted: { startDate: iso(0), values: [120 + tenant, 121 + tenant] } } }],
    // ProfileSet does not serialize syncIdentifier or _id. uploadProfile does
    // not automatically requeue failures. Do not invent a profile retry key.
    profile: [{ defaultProfile: 'Default', startDate: iso(0), mills: String(BASE),
      units: 'mg/dl', enteredBy: 'synthetic-loop', loopSettings: { dosingEnabled: false, overridePresets: [] },
      store: { Default: { dia: 6, carbs_hr: '0', delay: '0', timezone: 'UTC', units: 'mg/dl',
        basal: schedule(0.5 + tenant), carbratio: schedule(10), sens: schedule(45),
        target_low: schedule(100), target_high: schedule(110) } } }]
  };
}

// NightscoutClient.callNS/postToNS: exactly HTTP 200; exactly one object
// per submitted item. Missing string _id is accepted as NA by the Swift code.
function consumeUpload (reply, count) {
  assert.equal(reply.status, 200, 'NightscoutKit upload requires HTTP 200');
  assert.ok(Array.isArray(reply.body), 'NightscoutKit upload requires an array');
  assert.equal(reply.body.length, count, 'NightscoutKit upload response count');
  assert.ok(reply.body.every(value => value && typeof value === 'object' && !Array.isArray(value)));
  return reply.body.map(value => typeof value._id === 'string' ? value._id : 'NA');
}

function followerPath (domain, token, version = 1) {
  const query = new URLSearchParams({ token, count: domain === 'entries' ? '576' : domain === 'treatments' ? '100' : '1' });
  if (domain === 'entries') {
    query.set('find[date][$gte]', String(BASE));
    query.set('find[type][$ne]', 'cal');
  } else if (domain === 'treatments') {
    query.set('find[created_at][$gte]', iso(0));
    query.set('find[created_at][$lte]', iso(60000));
  } else if (domain === 'profile') query.set('find[startDate][$lte]', iso(60000));
  return '/api/v' + version + '/' + (domain === 'profile' ? 'profiles' : domain) + '.json?' + query;
}
module.exports = { sources, BASE, iso, documents, consumeUpload, followerPath };
