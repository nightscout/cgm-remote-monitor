'use strict';

/**
 * NightscoutKit Treatment Fixtures
 * 
 * Extracted from NightscoutKit Swift source:
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/NightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/BolusNightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/CarbCorrectionNightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/TempBasalNightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/MealBolusNightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/OverrideTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/BGCheckNightscoutTreatment.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/Treatments/NoteNightscoutTreatment.swift
 * 
 * NightscoutKit ALWAYS sends treatments as arrays (see NightscoutClient.swift:67):
 *   postToNS(treatments.map { $0.dictionaryRepresentation }, url: url, completion: completionHandler)
 * 
 * Treatment types (from NightscoutTreatment.swift:17-27):
 *   - "Correction Bolus"
 *   - "Carb Correction" 
 *   - "Temp Basal"
 *   - "Temporary Override"
 *   - "Meal Bolus"
 *   - "BG Check"
 *   - "Note"
 *   - "Sensor Start"
 *   - "Site Change"
 * 
 * Key field: syncIdentifier - client-provided ID for deduplication
 * (see NightscoutTreatment.swift:117-118):
 *   // Not part of the normal NS model, but we store here to be able to match to client provided ids
 *   rval["syncIdentifier"] = syncIdentifier
 */

const BASE_TIME = '2026-03-18T17:00:00.000Z';
const BASE_TIME_MS = 1773861600000;

// Helper: Generate ISO timestamp offset from BASE_TIME
function timestamp(minutesOffset = 0) {
  return new Date(BASE_TIME_MS + minutesOffset * 60 * 1000).toISOString();
}

// Helper: Generate UUID-like syncIdentifier
function generateSyncId(prefix = 'loop') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================
// BASE TREATMENT FIELDS
// From NightscoutTreatment.swift:105-120
// ============================================================
function baseTreatment(eventType, ts, enteredBy = 'Loop', options = {}) {
  const result = {
    created_at: ts,
    timestamp: ts,
    enteredBy: enteredBy,
    eventType: eventType
  };
  if (options._id) result._id = options._id;
  if (options.notes) result.notes = options.notes;
  if (options.insulinType) result.insulinType = options.insulinType;
  if (options.syncIdentifier) result.syncIdentifier = options.syncIdentifier;
  return result;
}

// ============================================================
// BOLUS TREATMENT
// From BolusNightscoutTreatment.swift:56-65
// ============================================================
function bolusTreatment(ts, amount, options = {}) {
  const base = baseTreatment('Correction Bolus', ts, options.enteredBy || 'Loop', options);
  return {
    ...base,
    type: options.bolusType || 'normal',   // 'normal', 'square', 'dual'
    insulin: amount,
    programmed: options.programmed ?? amount,
    unabsorbed: options.unabsorbed,
    duration: options.duration ?? 0,       // minutes (for square/dual wave)
    automatic: options.automatic ?? false
  };
}

// ============================================================
// CARB CORRECTION TREATMENT
// From CarbCorrectionNightscoutTreatment.swift:85-106
// ============================================================
function carbTreatment(ts, carbs, options = {}) {
  const base = baseTreatment('Carb Correction', ts, options.enteredBy || 'Loop', options);
  const result = {
    ...base,
    carbs: carbs
  };
  if (options.absorptionTime !== undefined) result.absorptionTime = options.absorptionTime; // minutes
  if (options.glucose !== undefined) {
    result.glucose = options.glucose;
    result.glucoseType = options.glucoseType || 'Sensor';
    result.units = options.units || 'mg/dL';
  }
  if (options.foodType) result.foodType = options.foodType;
  if (options.userEnteredAt) result.userEnteredAt = options.userEnteredAt;
  if (options.userLastModifiedAt) result.userLastModifiedAt = options.userLastModifiedAt;
  return result;
}

// ============================================================
// TEMP BASAL TREATMENT
// From TempBasalNightscoutTreatment.swift:61-70
// ============================================================
function tempBasalTreatment(ts, rate, durationMinutes, options = {}) {
  const base = baseTreatment('Temp Basal', ts, options.enteredBy || 'Loop', options);
  return {
    ...base,
    temp: options.rateType || 'absolute',   // 'absolute' or 'percentage'
    rate: rate,
    absolute: options.absolute ?? rate,
    duration: durationMinutes,
    amount: options.amount,                  // total insulin delivered
    automatic: options.automatic ?? true,
    reason: options.reason
  };
}

// ============================================================
// OVERRIDE TREATMENT
// From OverrideTreatment.swift:62-79
// ============================================================
function overrideTreatment(ts, reason, options = {}) {
  const base = baseTreatment('Temporary Override', ts, options.enteredBy || 'Loop', options);
  const result = {
    ...base,
    reason: reason
  };
  
  // Duration: either finite (minutes) or indefinite
  if (options.duration !== undefined) {
    result.duration = options.duration;
  } else if (options.durationType === 'indefinite') {
    result.durationType = 'indefinite';
  } else {
    result.duration = 60; // default 1 hour
  }
  
  if (options.correctionRange) {
    result.correctionRange = options.correctionRange; // [lower, upper] mg/dL
  }
  if (options.insulinNeedsScaleFactor !== undefined) {
    result.insulinNeedsScaleFactor = options.insulinNeedsScaleFactor;
  }
  if (options.remoteAddress) {
    result.remoteAddress = options.remoteAddress;
  }
  return result;
}

// ============================================================
// MEAL BOLUS TREATMENT (combo carbs + insulin)
// From MealBolusNightscoutTreatment.swift:56-72
// ============================================================
function mealBolusTreatment(ts, carbs, options = {}) {
  const base = baseTreatment('Meal Bolus', ts, options.enteredBy || 'Loop', options);
  const result = {
    ...base,
    carbs: carbs
  };
  if (options.absorptionTime !== undefined) result.absorptionTime = options.absorptionTime;
  if (options.insulin !== undefined) result.insulin = options.insulin;
  if (options.glucose !== undefined) {
    result.glucose = options.glucose;
    result.glucoseType = options.glucoseType || 'Sensor';
    result.units = options.units || 'mg/dL';
  }
  if (options.foodType) result.foodType = options.foodType;
  return result;
}

// ============================================================
// BG CHECK TREATMENT
// From BGCheckNightscoutTreatment.swift
// ============================================================
function bgCheckTreatment(ts, glucose, options = {}) {
  const base = baseTreatment('BG Check', ts, options.enteredBy || 'Loop', options);
  return {
    ...base,
    glucose: glucose,
    glucoseType: options.glucoseType || 'Finger',
    units: options.units || 'mg/dL'
  };
}

// ============================================================
// NOTE TREATMENT
// From NoteNightscoutTreatment.swift
// ============================================================
function noteTreatment(ts, notes, options = {}) {
  return baseTreatment('Note', ts, options.enteredBy || 'Loop', {
    ...options,
    notes: notes
  });
}

// ============================================================
// SITE CHANGE / SENSOR START
// Generic treatment types
// ============================================================
function siteChangeTreatment(ts, options = {}) {
  return baseTreatment('Site Change', ts, options.enteredBy || 'Loop', options);
}

function sensorStartTreatment(ts, options = {}) {
  return baseTreatment('Sensor Start', ts, options.enteredBy || 'Loop', options);
}

// ============================================================
// EXAMPLE FIXTURES
// ============================================================

// Correction bolus with syncIdentifier (typical Loop upload)
const correctionBolus = bolusTreatment(timestamp(0), 1.5, {
  syncIdentifier: 'loop-bolus-abc123-def456',
  automatic: true,
  insulinType: 'humalog',
  unabsorbed: 0.5
});

// Manual bolus (user-initiated)
const manualBolus = bolusTreatment(timestamp(-10), 3.0, {
  syncIdentifier: 'loop-bolus-manual-789012',
  automatic: false,
  programmed: 3.0,
  insulinType: 'novolog'
});

// Carb entry with absorption time
const carbEntry = carbTreatment(timestamp(-5), 45, {
  syncIdentifier: 'loop-carb-xyz789',
  absorptionTime: 180,  // 3 hours
  glucose: 120,
  glucoseType: 'Sensor',
  units: 'mg/dL',
  foodType: 'Mixed meal'
});

// Simple carb entry (minimal fields)
const simpleCarbEntry = carbTreatment(timestamp(-15), 30, {
  syncIdentifier: 'loop-carb-simple-001'
});

// Temp basal from Loop
const tempBasal = tempBasalTreatment(timestamp(-30), 1.2, 30, {
  syncIdentifier: 'loop-tempbasal-tb001',
  automatic: true,
  reason: 'Loop predicted high BG',
  insulinType: 'humalog'
});

// Zero temp basal (suspend)
const zeroTempBasal = tempBasalTreatment(timestamp(-20), 0, 30, {
  syncIdentifier: 'loop-tempbasal-suspend-002',
  automatic: true,
  reason: 'Low predicted, suspending'
});

// Override treatment (exercise mode)
const exerciseOverride = overrideTreatment(timestamp(-60), 'Running', {
  syncIdentifier: 'loop-override-run001',
  duration: 90,  // 1.5 hours
  correctionRange: [140, 160],
  insulinNeedsScaleFactor: 0.75
});

// Indefinite override
const indefiniteOverride = overrideTreatment(timestamp(-120), 'Sick Day', {
  syncIdentifier: 'loop-override-sick001',
  durationType: 'indefinite',
  correctionRange: [120, 140],
  insulinNeedsScaleFactor: 1.5
});

// Meal bolus (carbs + insulin together)
const mealBolus = mealBolusTreatment(timestamp(-45), 60, {
  syncIdentifier: 'loop-meal-lunch001',
  insulin: 6.0,
  absorptionTime: 240,
  glucose: 135,
  foodType: 'Lunch',
  insulinType: 'humalog'
});

// BG check (finger stick)
const bgCheck = bgCheckTreatment(timestamp(-90), 110, {
  syncIdentifier: 'loop-bg-check001',
  glucoseType: 'Finger'
});

// Note treatment
const note = noteTreatment(timestamp(-180), 'Started new sensor', {
  syncIdentifier: 'loop-note-001'
});

// Site change
const siteChange = siteChangeTreatment(timestamp(-240), {
  syncIdentifier: 'loop-site-001',
  notes: 'Left abdomen'
});

// Sensor start
const sensorStart = sensorStartTreatment(timestamp(-300), {
  syncIdentifier: 'loop-sensor-001',
  notes: 'Dexcom G7'
});

// Second bolus for batch testing
const secondBolus = bolusTreatment(timestamp(-5), 0.8, {
  syncIdentifier: 'loop-bolus-second-456',
  automatic: true,
  insulinType: 'humalog'
});

// Second carb for batch testing
const secondCarb = carbTreatment(timestamp(-25), 20, {
  syncIdentifier: 'loop-carb-second-789',
  absorptionTime: 120
});

module.exports = {
  // Helper functions for building custom fixtures
  helpers: {
    timestamp,
    generateSyncId,
    baseTreatment,
    bolusTreatment,
    carbTreatment,
    tempBasalTreatment,
    overrideTreatment,
    mealBolusTreatment,
    bgCheckTreatment,
    noteTreatment,
    siteChangeTreatment,
    sensorStartTreatment
  },

  // Individual treatment objects
  correctionBolus,
  manualBolus,
  carbEntry,
  simpleCarbEntry,
  tempBasal,
  zeroTempBasal,
  exerciseOverride,
  indefiniteOverride,
  mealBolus,
  bgCheck,
  note,
  siteChange,
  sensorStart,
  secondBolus,
  secondCarb,

  // ============================================================
  // ARRAY FORMATS - What NightscoutKit actually sends to POST /api/v1/treatments
  // ============================================================

  // Single bolus in array
  singleBolusArray: [correctionBolus],

  // Single carb in array
  singleCarbArray: [carbEntry],

  // Single temp basal in array
  singleTempBasalArray: [tempBasal],

  // Override in array
  overrideArray: [exerciseOverride],

  // Batch upload: multiple treatments in single request
  // This is common - Loop batches treatments for efficiency
  batchArray: [correctionBolus, carbEntry, tempBasal],

  // Bolus + carb pair (common meal scenario)
  mealPairArray: [carbEntry, manualBolus],

  // Two boluses batch
  twoBolusArray: [correctionBolus, secondBolus],

  // Two carbs batch
  twoCarbArray: [carbEntry, secondCarb],

  // Mixed batch with all treatment types
  mixedBatchArray: [
    correctionBolus,
    carbEntry,
    tempBasal,
    exerciseOverride,
    bgCheck,
    note
  ],

  // Historical sync - multiple temp basals
  tempBasalHistoryArray: [
    tempBasal,
    zeroTempBasal,
    tempBasalTreatment(timestamp(-45), 1.5, 30, {
      syncIdentifier: 'loop-tempbasal-003',
      automatic: true
    })
  ],

  // ============================================================
  // EXPECTED RESPONSES
  // ============================================================

  expectedResponseFormat: {
    description: 'NightscoutKit expects array response with _id fields',
    example: [
      { _id: '507f1f77bcf86cd799439011', ...correctionBolus }
    ]
  },

  // ============================================================
  // SPECIAL CASES
  // ============================================================

  // Generate unique bolus for dedup testing
  generateUniqueBolus: function(suffix) {
    return bolusTreatment(new Date().toISOString(), Math.random() * 5, {
      syncIdentifier: `loop-bolus-test-${Date.now()}-${suffix}`,
      automatic: true,
      insulinType: 'humalog'
    });
  },

  // Generate unique carb for dedup testing
  generateUniqueCarb: function(suffix) {
    return carbTreatment(new Date().toISOString(), Math.floor(Math.random() * 100), {
      syncIdentifier: `loop-carb-test-${Date.now()}-${suffix}`,
      absorptionTime: 180
    });
  },

  // Generate treatment array for batch testing
  generateBatch: function(count, type = 'bolus') {
    const result = [];
    for (let i = 0; i < count; i++) {
      const ts = new Date(Date.now() - i * 5 * 60 * 1000).toISOString();
      if (type === 'bolus') {
        result.push(bolusTreatment(ts, Math.random() * 3, {
          syncIdentifier: `loop-batch-bolus-${i}`,
          automatic: true
        }));
      } else if (type === 'carb') {
        result.push(carbTreatment(ts, Math.floor(Math.random() * 50) + 10, {
          syncIdentifier: `loop-batch-carb-${i}`,
          absorptionTime: 180
        }));
      }
    }
    return result;
  },

  // ============================================================
  // EVENT TYPES (for reference)
  // ============================================================
  eventTypes: {
    CORRECTION_BOLUS: 'Correction Bolus',
    CARB_CORRECTION: 'Carb Correction',
    TEMP_BASAL: 'Temp Basal',
    TEMPORARY_OVERRIDE: 'Temporary Override',
    MEAL_BOLUS: 'Meal Bolus',
    BG_CHECK: 'BG Check',
    NOTE: 'Note',
    SENSOR_START: 'Sensor Start',
    SITE_CHANGE: 'Site Change'
  }
};
