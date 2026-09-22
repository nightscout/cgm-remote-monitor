'use strict';

// Data field mappings originate in nightscout-connect/minimedcarelink and
// minimed-connect-to-nightscout. Explicit timestamps are preserved; naive
// timestamps require the conduit offset, never the Nightscout host timezone.
const crypto = require('node:crypto');
const TRENDS = { NONE: 'Flat', UP: 'SingleUp', UP_DOUBLE: 'DoubleUp', UP_TRIPLE: 'TripleUp',
  DOWN: 'SingleDown', DOWN_DOUBLE: 'DoubleDown', DOWN_TRIPLE: 'TripleDown' };

function timestamp(value, conduit) {
  if (typeof value !== 'string') return NaN;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const offset = typeof conduit === 'string' && conduit.match(/(Z|[+-]\d{2}:\d{2})$/);
    if (!offset) return NaN;
    value += offset[0];
  }
  return Date.parse(value);
}
function identifier(patient, kind, key) {
  return 'carelink-' + crypto.createHash('sha256').update(JSON.stringify([patient, kind, key])).digest('hex');
}

function transform(data, patient, now = Date.now()) {
  const device = 'nightscout-connect://minimedcarelink/' + (data.medicalDeviceFamily || 'unknown');
  const validTime = time => Number.isFinite(time) && time > now - 7 * 86400000 && time <= now + 300000;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const entries = [];
  const seen = new Set();
  for (const reading of (Array.isArray(data.sgs) ? data.sgs : [])) {
    if (!reading || typeof reading !== 'object') continue;
    const date = timestamp(reading.datetime, data.lastConduitDateTime);
    // Preserve Nightscout's LOW/HIGH sentinels (39/401), not error codes/zero.
    if (!validTime(date) || !finite(reading.sg) || reading.sg < 39 || reading.sg > 401 || seen.has(date)) continue;
    seen.add(date);
    entries.push({ type: 'sgv', sgv: reading.sg, date, dateString: new Date(date).toISOString(), device,
      identifier: identifier(patient, 'sgv', date) });
  }
  entries.sort((a, b) => a.date - b.date);
  const last = entries[entries.length - 1];
  if (last && data.lastSG && last.sgv === data.lastSG.sg && TRENDS[data.lastSGTrend]) {
    last.direction = TRENDS[data.lastSGTrend];
  }
  const treatments = [];
  const markers = Array.isArray(data.markers) ? data.markers.filter(m => m && typeof m === 'object') : [];
  const paired = new Set();
  function treatment(item, fields) {
    const date = timestamp(item.dateTime, data.lastConduitDateTime);
    if (!validTime(date)) return;
    treatments.push({ ...fields, created_at: new Date(date).toISOString(), enteredBy: device,
      identifier: identifier(patient, 'marker', [date, item.type, item.index ?? null]) });
  }
  for (const item of markers.filter(m => m.type === 'MEAL')) {
    if (!finite(item.amount) || item.amount <= 0) continue;
    const dose = item.index !== undefined && markers.find(m => m.type === 'INSULIN' && m.index === item.index && m.bolusType === 'FAST');
    const fields = { eventType: 'Carb Correction', carbs: item.amount };
    if (dose && finite(dose.deliveredFastAmount) && dose.deliveredFastAmount > 0) {
      fields.eventType = 'Meal Bolus';
      fields.insulin = dose.deliveredFastAmount;
      paired.add(dose);
    }
    treatment(item, fields);
  }
  for (const item of markers) {
    if (item.type === 'INSULIN' && !paired.has(item) && item.bolusType === 'FAST' && finite(item.deliveredFastAmount) && item.deliveredFastAmount > 0) {
      treatment(item, { eventType: 'Correction Bolus', insulin: item.deliveredFastAmount });
    } else if (['CALIBRATION', 'BG READING', 'BG'].includes(item.type) && finite(item.value) && item.value > 0) {
      treatment(item, { eventType: 'BG Check', glucose: item.value, glucoseType: 'Finger', units: 'mg/dl' });
    }
  }
  const devicestatus = [];
  const updated = timestamp(data.lastMedicalDeviceDataUpdateServerTime, data.lastConduitDateTime);
  if (validTime(updated)) {
    const status = { created_at: new Date(updated).toISOString(), device,
      identifier: identifier(patient, 'device', updated), connect: {} };
    for (const key of ['sensorState', 'calibStatus', 'sensorDurationHours', 'timeToNextCalibHours',
      'conduitInRange', 'conduitMedicalDeviceInRange', 'conduitSensorInRange', 'medicalDeviceFamily']) {
      if (['number', 'string', 'boolean'].includes(typeof data[key])) status.connect[key] = data[key];
    }
    if (finite(data.medicalDeviceBatteryLevelPercent)) status.uploader = { battery: data.medicalDeviceBatteryLevelPercent };
    if (data.medicalDeviceFamily && data.medicalDeviceFamily !== 'GUARDIAN') {
      status.pump = {};
      if (status.uploader) status.pump.battery = { percent: status.uploader.battery };
      if (finite(data.reservoirRemainingUnits) && data.reservoirRemainingUnits >= 0) status.pump.reservoir = data.reservoirRemainingUnits;
      if (data.activeInsulin && finite(data.activeInsulin.amount) && data.activeInsulin.amount >= 0) status.pump.bolusiob = data.activeInsulin.amount;
      const clock = timestamp(data.sMedicalDeviceTime, data.lastConduitDateTime);
      if (validTime(clock)) status.pump.clock = new Date(clock).toISOString();
    }
    devicestatus.push(status);
  }
  return { entries, treatments, devicestatus };
}
module.exports = { transform, timestamp };
