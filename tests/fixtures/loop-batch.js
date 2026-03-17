'use strict';

module.exports = {
  glucoseBatch: [
    { type: 'sgv', sgv: 120, date: Date.now(), dateString: new Date().toISOString(), direction: 'Flat', device: 'loop://iPhone' },
    { type: 'sgv', sgv: 125, date: Date.now() + 300000, dateString: new Date(Date.now() + 300000).toISOString(), direction: 'FortyFiveUp', device: 'loop://iPhone' },
    { type: 'sgv', sgv: 130, date: Date.now() + 600000, dateString: new Date(Date.now() + 600000).toISOString(), direction: 'SingleUp', device: 'loop://iPhone' }
  ],

  carbsBatch: [
    { eventType: 'Carb Correction', carbs: 15, created_at: new Date().toISOString(), enteredBy: 'loop://iPhone', absorptionTime: 180 },
    { eventType: 'Carb Correction', carbs: 30, created_at: new Date(Date.now() + 3600000).toISOString(), enteredBy: 'loop://iPhone', absorptionTime: 240 }
  ],

  doseBatch: [
    { eventType: 'Temp Basal', duration: 30, rate: 1.5, absolute: 1.5, created_at: new Date().toISOString(), enteredBy: 'loop://iPhone' },
    { eventType: 'Bolus', insulin: 2.0, created_at: new Date(Date.now() + 60000).toISOString(), enteredBy: 'loop://iPhone' },
    { eventType: 'Temp Basal', duration: 30, rate: 0.5, absolute: 0.5, created_at: new Date(Date.now() + 120000).toISOString(), enteredBy: 'loop://iPhone' }
  ],

  overrideBatch: [
    {
      eventType: 'Temporary Override',
      reason: 'Pre-Meal',
      created_at: new Date().toISOString(),
      enteredBy: 'loop://iPhone',
      duration: 60,
      targetRange: { minValue: 80, maxValue: 80 },
      insulinNeedsScaleFactor: 1.0
    }
  ],

  deviceStatusBatch: [
    {
      device: 'loop://iPhone',
      created_at: new Date().toISOString(),
      uploaderBattery: 85,
      loop: {
        version: '3.0.0',
        timestamp: new Date().toISOString(),
        iob: { iob: 2.5, timestamp: new Date().toISOString() },
        cob: { cob: 15, timestamp: new Date().toISOString() },
        predicted: {
          startDate: new Date().toISOString(),
          values: [120, 118, 115, 112, 110, 108, 105]
        },
        enacted: {
          timestamp: new Date().toISOString(),
          rate: 1.2,
          duration: 30,
          received: true
        }
      },
      pump: {
        clock: new Date().toISOString(),
        reservoir: 150,
        battery: { percent: 75 }
      }
    }
  ],

  cgmEventBatch: [
    { eventType: 'Sensor Start', created_at: new Date().toISOString(), enteredBy: 'loop://iPhone' },
    { eventType: 'Calibration', glucose: 120, glucoseType: 'Finger', created_at: new Date(Date.now() + 3600000).toISOString(), enteredBy: 'loop://iPhone' }
  ],

  largeBatch: (function() {
    var batch = [];
    for (var i = 0; i < 100; i++) {
      batch.push({
        type: 'sgv',
        sgv: 100 + (i % 50),
        date: Date.now() + (i * 300000),
        dateString: new Date(Date.now() + (i * 300000)).toISOString(),
        direction: 'Flat',
        device: 'loop://iPhone'
      });
    }
    return batch;
  })(),

  maxBatch: (function() {
    var batch = [];
    for (var i = 0; i < 1000; i++) {
      batch.push({
        type: 'sgv',
        sgv: 80 + Math.floor(Math.random() * 100),
        date: Date.now() - (i * 300000),
        dateString: new Date(Date.now() - (i * 300000)).toISOString(),
        direction: ['Flat', 'FortyFiveUp', 'FortyFiveDown', 'SingleUp', 'SingleDown'][i % 5],
        device: 'loop://iPhone'
      });
    }
    return batch;
  })()
};
