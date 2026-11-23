'use strict';

module.exports = {
  sgvEntry: {
    type: 'sgv',
    sgv: 120,
    date: Date.now(),
    dateString: new Date().toISOString(),
    device: 'AndroidAPS-DexcomG6',
    direction: 'Flat',
    app: 'AAPS',
    utcOffset: 120
  },
  
  smbBolus: {
    eventType: 'Correction Bolus',
    insulin: 0.25,
    created_at: new Date().toISOString(),
    date: Date.now(),
    type: 'SMB',
    isValid: true,
    isSMB: true,
    pumpId: 4148,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  },

  mealBolus: {
    eventType: 'Meal Bolus',
    insulin: 8.1,
    carbs: 45,
    created_at: new Date().toISOString(),
    date: Date.now(),
    type: 'NORMAL',
    isValid: true,
    isSMB: false,
    pumpId: 4102,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  },

  tempBasal: {
    eventType: 'Temp Basal',
    created_at: new Date().toISOString(),
    enteredBy: 'openaps://AndroidAPS',
    isValid: true,
    duration: 60,
    rate: 0,
    type: 'NORMAL',
    absolute: 0,
    pumpId: 284835,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    app: 'AAPS'
  },

  carbCorrection: {
    eventType: 'Carb Correction',
    carbs: 15,
    created_at: new Date().toISOString(),
    isValid: true,
    date: Date.now(),
    app: 'AAPS'
  },

  temporaryTarget: {
    eventType: 'Temporary Target',
    duration: 60,
    isValid: true,
    created_at: new Date().toISOString(),
    enteredBy: 'AndroidAPS',
    reason: 'Eating Soon',
    targetBottom: 80,
    targetTop: 80,
    units: 'mg/dl',
    app: 'AAPS'
  },

  profileSwitch: {
    eventType: 'Profile Switch',
    created_at: new Date().toISOString(),
    enteredBy: 'openaps://AndroidAPS',
    isValid: true,
    duration: 0,
    profile: 'DefaultProfile',
    profileJson: JSON.stringify({
      units: 'mg/dl',
      dia: 5,
      timezone: 'America/New_York',
      sens: [{ time: '00:00', timeAsSeconds: 0, value: 45 }],
      carbratio: [{ time: '00:00', timeAsSeconds: 0, value: 10 }],
      basal: [{ time: '00:00', timeAsSeconds: 0, value: 0.8 }]
    }),
    timeshift: 0,
    percentage: 100,
    app: 'AAPS'
  },

  deviceStatus: {
    app: 'AAPS',
    date: Date.now(),
    created_at: new Date().toISOString(),
    device: 'openaps://samsung SM-G970F',
    uploaderBattery: 85,
    isCharging: false,
    pump: {
      clock: new Date().toISOString(),
      reservoir: 150.5,
      battery: { percent: 75 },
      status: { status: 'normal', timestamp: new Date().toISOString() },
      extended: {
        Version: '3.2.0.0',
        LastBolus: new Date().toISOString(),
        LastBolusAmount: 2.5,
        TempBasalAbsoluteRate: 1.2,
        BaseBasalRate: 1.0,
        ActiveProfile: 'DefaultProfile'
      }
    },
    openaps: {
      suggested: {
        temp: 'absolute',
        bg: 120,
        tick: -2,
        eventualBG: 110,
        snoozeBG: 105,
        predBGs: { IOB: [120, 115, 110, 108, 105] },
        COB: 10,
        IOB: 2.5,
        reason: 'COB: 10, Dev: -10, BGI: -1.5, ISF: 45, Target: 100',
        timestamp: new Date().toISOString()
      },
      enacted: {
        temp: 'absolute',
        bg: 120,
        rate: 1.2,
        duration: 30,
        recieved: true,
        reason: 'COB: 10, Dev: -10, BGI: -1.5'
      },
      iob: {
        iob: 2.5,
        basaliob: 1.2,
        activity: 0.02,
        time: new Date().toISOString()
      }
    },
    configuration: {
      pump: 'DanaR',
      version: '3.2.0.0',
      insulin: 5,
      aps: 'openAPSSMB',
      sensitivity: 2
    }
  }
};
