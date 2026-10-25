'use strict';

module.exports = {
  glucosePipeline: [
    { sgv: 110, date: Date.now(), dateString: new Date().toISOString(), direction: 'Flat', type: 'sgv', device: 'Trio' },
    { sgv: 115, date: Date.now() + 300000, dateString: new Date(Date.now() + 300000).toISOString(), direction: 'FortyFiveUp', type: 'sgv', device: 'Trio' },
    { sgv: 120, date: Date.now() + 600000, dateString: new Date(Date.now() + 600000).toISOString(), direction: 'Flat', type: 'sgv', device: 'Trio' }
  ],

  treatmentPipeline: [
    {
      eventType: 'Meal Bolus',
      insulin: 5.0,
      carbs: 45,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio',
      id: 'trio-uuid-meal-1'
    },
    {
      eventType: 'Correction Bolus',
      insulin: 1.5,
      created_at: new Date(Date.now() + 60000).toISOString(),
      enteredBy: 'Trio',
      id: 'trio-uuid-corr-1'
    }
  ],

  tempTargetPipeline: [
    {
      eventType: 'Temporary Target',
      duration: 60,
      targetTop: 110,
      targetBottom: 110,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio',
      reason: 'Eating Soon',
      id: 'trio-uuid-tt-1'
    },
    {
      eventType: 'Temporary Target',
      duration: 120,
      targetTop: 150,
      targetBottom: 150,
      created_at: new Date(Date.now() + 7200000).toISOString(),
      enteredBy: 'Trio',
      reason: 'Activity',
      id: 'trio-uuid-tt-2'
    }
  ],

  overridePipeline: [
    {
      eventType: 'Exercise',
      duration: 60,
      notes: 'Running',
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    },
    {
      eventType: 'Exercise',
      duration: 30,
      notes: 'Walking',
      created_at: new Date(Date.now() + 3600000).toISOString(),
      enteredBy: 'Trio'
    }
  ],

  carbsPipeline: [
    {
      eventType: 'Carb Correction',
      carbs: 20,
      fat: 10,
      protein: 5,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio',
      id: 'trio-uuid-carbs-1'
    }
  ],

  pumpHistoryPipeline: [
    {
      eventType: 'Temp Basal',
      duration: 30,
      rate: 1.5,
      absolute: 1.5,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    },
    {
      eventType: 'Temp Basal',
      duration: 30,
      rate: 0.0,
      absolute: 0.0,
      created_at: new Date(Date.now() + 1800000).toISOString(),
      enteredBy: 'Trio'
    }
  ],

  deviceStatus: {
    device: 'Trio',
    created_at: new Date().toISOString(),
    uploaderBattery: 85,
    pump: {
      clock: new Date().toISOString(),
      reservoir: 150,
      reservoir_display_override: '150U',
      battery: { percent: 75, voltage: 1.5 },
      status: { status: 'normal', timestamp: new Date().toISOString() },
      extended: {
        Version: '1.0.0',
        LastBolus: new Date(Date.now() - 3600000).toISOString(),
        LastBolusAmount: 5.0,
        TempBasalAbsoluteRate: 1.2,
        TempBasalStart: new Date().toISOString(),
        TempBasalRemaining: 25,
        BaseBasalRate: 1.0,
        ActiveProfile: 'Default'
      }
    },
    openaps: {
      suggested: {
        temp: 'absolute',
        bg: 120,
        tick: -2,
        eventualBG: 110,
        snoozeBG: 105,
        predBGs: {
          IOB: [120, 115, 112, 108, 105, 102, 100],
          COB: [120, 118, 115, 110, 105, 100, 95],
          UAM: [120, 118, 116, 114, 112, 110, 108]
        },
        COB: 15,
        IOB: 2.5,
        reason: 'COB: 15, Dev: -10, BGI: -1.8, ISF: 45, Target: 100; Eventual BG 110 > 100',
        timestamp: new Date().toISOString(),
        current_target: 100,
        minPredBG: 95,
        minGuardBG: 90,
        threshold: 65,
        tdd: 45.5
      },
      enacted: {
        temp: 'absolute',
        bg: 120,
        rate: 1.5,
        duration: 30,
        recieved: true,
        reason: 'COB: 15, Dev: -10, BGI: -1.8',
        timestamp: new Date().toISOString()
      },
      iob: {
        iob: 2.5,
        basaliob: 1.2,
        activity: 0.025,
        time: new Date().toISOString()
      }
    },
    uploader: {
      battery: 85
    },
    configuration: {
      pump: 'Omnipod',
      version: '1.0.0',
      insulin: 5,
      aps: 'oref1',
      sensitivity: 2,
      insulinConfiguration: {},
      sensitivityConfiguration: {
        openapsama_min_5m_carbimpact: 8,
        absorption_cutoff: 4,
        autosens_max: 1.2,
        autosens_min: 0.7
      },
      overviewConfiguration: {
        units: 'mg/dl',
        low_mark: 70,
        high_mark: 180
      },
      safetyConfiguration: {
        age: 'adult',
        treatmentssafety_maxbolus: 10,
        treatmentssafety_maxcarbs: 120
      }
    }
  },

  manualGlucosePipeline: [
    {
      eventType: 'BG Check',
      glucose: 125,
      glucoseType: 'Finger',
      units: 'mg/dl',
      created_at: new Date().toISOString(),
      enteredBy: 'Trio',
      id: 'trio-uuid-bg-1'
    }
  ]
};
