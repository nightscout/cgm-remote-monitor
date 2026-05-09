'use strict';

module.exports = {
  emptyArray: [],

  singleItemArray: [
    { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat', device: 'test' }
  ],

  nullAndUndefinedFields: {
    type: 'sgv',
    sgv: 120,
    date: Date.now(),
    direction: null,
    device: undefined,
    noise: null,
    filtered: undefined
  },

  mixedValidityBatch: [
    { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat', isValid: true },
    { type: 'sgv', sgv: 115, date: Date.now() - 300000, direction: 'Flat', isValid: false },
    { type: 'sgv', sgv: 125, date: Date.now() + 300000, direction: 'FortyFiveUp', isValid: true }
  ],

  extendedEmulatedTempBasal: {
    eventType: 'Temp Basal',
    created_at: new Date().toISOString(),
    enteredBy: 'openaps://AndroidAPS',
    isValid: true,
    duration: 3,
    rate: 2.4391549295774646,
    type: 'FAKE_EXTENDED',
    absolute: 2.4391549295774646,
    pumpId: 4147,
    pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
    pumpSerial: '33013206',
    extendedEmulated: {
      created_at: new Date().toISOString(),
      enteredBy: 'openaps://AndroidAPS',
      eventType: 'Combo Bolus',
      duration: 3,
      splitNow: 0,
      splitExt: 100,
      enteredinsulin: 0.11,
      relative: 1.8591549295774648,
      isValid: true,
      isEmulatingTempBasal: true,
      pumpId: 4147,
      pumpType: 'ACCU_CHEK_INSIGHT_BLUETOOTH',
      pumpSerial: '33013206'
    }
  },

  largeProfileJson: {
    eventType: 'Profile Switch',
    created_at: new Date().toISOString(),
    enteredBy: 'openaps://AndroidAPS',
    isValid: true,
    duration: 0,
    profile: 'ComplexProfile',
    profileJson: JSON.stringify({
      units: 'mg/dl',
      dia: 5,
      timezone: 'America/New_York',
      sens: Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        timeAsSeconds: i * 3600,
        value: 40 + (i < 12 ? i * 2 : (24 - i) * 2)
      })),
      carbratio: Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        timeAsSeconds: i * 3600,
        value: 8 + (i < 12 ? i * 0.5 : (24 - i) * 0.5)
      })),
      basal: Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        timeAsSeconds: i * 3600,
        value: 0.5 + (i >= 6 && i <= 10 ? 0.3 : 0) + (i >= 14 && i <= 18 ? 0.2 : 0)
      })),
      target_low: Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        timeAsSeconds: i * 3600,
        value: i >= 22 || i < 6 ? 100 : 90
      })),
      target_high: Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        timeAsSeconds: i * 3600,
        value: i >= 22 || i < 6 ? 120 : 110
      }))
    }),
    timeshift: 0,
    percentage: 100
  },

  bolusWizardWithResult: {
    eventType: 'Bolus Wizard',
    created_at: new Date().toISOString(),
    isValid: true,
    bolusCalculatorResult: JSON.stringify({
      basalIOB: -0.247,
      bolusIOB: -1.837,
      carbs: 45.0,
      carbsInsulin: 9.0,
      cob: 0.0,
      cobInsulin: 0.0,
      dateCreated: Date.now(),
      glucoseDifference: 44.0,
      glucoseInsulin: 0.898,
      glucoseTrend: 5.5,
      glucoseValue: 134.0,
      ic: 5.0,
      id: 331,
      isValid: true,
      isf: 49.0,
      note: '',
      otherCorrection: 0.0,
      percentageCorrection: 90,
      profileName: 'Default',
      superbolusInsulin: 0.0,
      targetBGHigh: 90.0,
      targetBGLow: 90.0,
      timestamp: Date.now(),
      totalInsulin: 7.34,
      trendInsulin: 0.337,
      utcOffset: 0,
      version: 1,
      wasBasalIOBUsed: true,
      wasBolusIOBUsed: true,
      wasCOBUsed: true,
      wasGlucoseUsed: true,
      wasSuperbolusUsed: false,
      wasTempTargetUsed: false,
      wasTrendUsed: true,
      wereCarbsUsed: false
    }),
    date: Date.now(),
    glucose: 134,
    units: 'mg/dl',
    notes: ''
  },

  unicodeContent: {
    eventType: 'Note',
    created_at: new Date().toISOString(),
    notes: 'Test with unicode: 🍕 lunch, 🏃 activity, 日本語テスト, émojis: 💉🩸📊',
    enteredBy: 'Test'
  },

  veryLongNotes: {
    eventType: 'Note',
    created_at: new Date().toISOString(),
    notes: 'A'.repeat(10000),
    enteredBy: 'Test'
  },

  timestampFormats: [
    { eventType: 'Note', created_at: '2024-01-18T12:00:00.000Z', notes: 'ISO with Z' },
    { eventType: 'Note', created_at: '2024-01-18T14:00:00.000+02:00', notes: 'ISO with offset' },
    { eventType: 'Note', created_at: 1705579200000, notes: 'Unix ms' },
    { eventType: 'Note', created_at: 1705579200, notes: 'Unix seconds' }
  ],

  decimalPrecision: {
    eventType: 'Correction Bolus',
    insulin: 0.123456789,
    rate: 1.9999999999,
    absolute: 0.00000001,
    created_at: new Date().toISOString()
  },

  negativeValues: {
    eventType: 'Note',
    glucose: -10,
    utcOffset: -480,
    duration: -30,
    created_at: new Date().toISOString()
  },

  largeNumbers: {
    type: 'sgv',
    sgv: 999999,
    date: 9999999999999,
    filtered: 999999999.99999,
    unfiltered: 999999999.99999
  },

  specialCharactersInStrings: {
    eventType: 'Note',
    notes: 'Test with special chars: <script>alert("xss")</script> & "quotes" \'apostrophes\' $variables ${interpolation}',
    enteredBy: 'Test<>User',
    profile: 'Profile/With\\Slashes',
    reason: 'Reason with\nnewlines\tand\ttabs'
  },

  arrayInNestedObject: {
    device: 'test',
    created_at: new Date().toISOString(),
    openaps: {
      suggested: {
        predBGs: {
          IOB: [120, 115, 110, 105, 100, 95, 90],
          COB: [120, 118, 115, 112, 108, 105, 102],
          UAM: [120, 122, 125, 128, 130, 132, 135],
          ZT: [120, 115, 110, 108, 105, 103, 100]
        }
      }
    }
  },

  zeroValues: {
    eventType: 'Temp Basal',
    duration: 0,
    rate: 0,
    absolute: 0,
    insulin: 0,
    carbs: 0,
    created_at: new Date().toISOString()
  },

  booleanEdgeCases: [
    { eventType: 'Note', isValid: true },
    { eventType: 'Note', isValid: false },
    { eventType: 'Note', isValid: 'true' },
    { eventType: 'Note', isValid: 1 },
    { eventType: 'Note', isValid: 0 }
  ]
};
