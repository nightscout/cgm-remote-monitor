'use strict';

/**
 * NightscoutKit Profile Fixtures
 * 
 * Extracted from NightscoutKit Swift source:
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/ProfileSet.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/LoopSettings.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/TemporaryScheduleOverride.swift
 * 
 * NightscoutKit ALWAYS sends profiles as arrays (see NightscoutClient.swift:404):
 *   postToNS([profileSet.dictionaryRepresentation], url: url, completion: completion)
 * 
 * Response expectation (NightscoutClient.swift:488):
 *   guard let insertedEntries = postResponse as? [[String: Any]], 
 *         insertedEntries.count == json.count
 */

// Helper: Create a schedule item matching NightscoutKit's ScheduleItem.dictionaryRepresentation
function scheduleItem(offsetHours, offsetMinutes, value) {
  const totalSeconds = (offsetHours * 3600) + (offsetMinutes * 60);
  return {
    time: String(offsetHours).padStart(2, '0') + ':' + String(offsetMinutes).padStart(2, '0'),
    timeAsSeconds: totalSeconds,
    value: value
  };
}

// Minimal valid profile following NightscoutKit structure
const minimalProfile = {
  defaultProfile: 'Default',
  startDate: '2026-03-16T14:00:00.000Z',
  mills: '1773849600000',
  units: 'mg/dl',
  enteredBy: 'Loop',
  loopSettings: {
    dosingEnabled: true,
    overridePresets: []
  },
  store: {
    Default: {
      dia: 6,
      carbs_hr: '0',
      delay: '0',
      timezone: 'ETC/GMT+5',
      target_low: [scheduleItem(0, 0, 100)],
      target_high: [scheduleItem(0, 0, 110)],
      sens: [scheduleItem(0, 0, 45)],
      basal: [scheduleItem(0, 0, 1.0)],
      carbratio: [scheduleItem(0, 0, 10)],
      units: 'mg/dl'
    }
  }
};

// Full profile with loopSettings (typical Loop upload)
const fullLoopProfile = {
  defaultProfile: 'Default',
  startDate: '2026-03-16T14:01:00.000Z',
  mills: '1773849660000',
  units: 'mg/dl',
  enteredBy: 'Loop',
  loopSettings: {
    bundleIdentifier: 'com.loopkit.Loop',
    dosingStrategy: 'tempBasalOnly',
    dosingEnabled: true,
    preMealTargetRange: [70, 70],
    overridePresets: [
      {
        symbol: '🏃',
        targetRange: [140, 160],
        name: 'Running',
        insulinNeedsScaleFactor: 0.8,
        duration: 3600
      },
      {
        symbol: '🍽️',
        targetRange: [100, 110],
        name: 'Pre-Meal',
        duration: 3600
      }
    ],
    scheduleOverride: null,
    deviceToken: 'abc123def456',
    maximumBasalRatePerHour: 5.0,
    maximumBolus: 10.0,
    minimumBGGuard: 70
  },
  store: {
    Default: {
      dia: 6,
      carbs_hr: '0',
      delay: '0',
      timezone: 'ETC/GMT+5',
      target_low: [scheduleItem(0, 0, 100)],
      target_high: [scheduleItem(0, 0, 110)],
      sens: [
        scheduleItem(0, 0, 45),
        scheduleItem(8, 0, 40),
        scheduleItem(20, 0, 50)
      ],
      basal: [
        scheduleItem(0, 0, 0.8),
        scheduleItem(6, 0, 1.2),
        scheduleItem(12, 0, 1.0),
        scheduleItem(18, 0, 0.9),
        scheduleItem(22, 0, 0.7)
      ],
      carbratio: [
        scheduleItem(0, 0, 12),
        scheduleItem(6, 0, 10),
        scheduleItem(12, 0, 11),
        scheduleItem(18, 0, 10)
      ],
      units: 'mg/dl'
    }
  }
};

// Profile with active override
const profileWithActiveOverride = {
  defaultProfile: 'Default',
  startDate: '2026-03-16T15:00:00.000Z',
  mills: '1773853200000',
  units: 'mg/dl',
  enteredBy: 'Loop',
  loopSettings: {
    bundleIdentifier: 'com.loopkit.Loop',
    dosingStrategy: 'automaticBolus',
    dosingEnabled: true,
    preMealTargetRange: [70, 70],
    overridePresets: [
      {
        symbol: '🏃',
        targetRange: [140, 160],
        name: 'Running',
        insulinNeedsScaleFactor: 0.75,
        duration: 5400
      }
    ],
    scheduleOverride: {
      symbol: '🏃',
      targetRange: [140, 160],
      name: 'Running',
      insulinNeedsScaleFactor: 0.75,
      duration: 5400
    },
    deviceToken: 'abc123def456',
    maximumBasalRatePerHour: 5.0,
    maximumBolus: 10.0,
    minimumBGGuard: 65
  },
  store: {
    Default: {
      dia: 6,
      carbs_hr: '0',
      delay: '0',
      timezone: 'ETC/GMT+8',
      target_low: [scheduleItem(0, 0, 95)],
      target_high: [scheduleItem(0, 0, 105)],
      sens: [scheduleItem(0, 0, 40)],
      basal: [scheduleItem(0, 0, 1.0)],
      carbratio: [scheduleItem(0, 0, 10)],
      units: 'mg/dl'
    }
  }
};

// Profile with mmol/L units (common outside US)
const mmolProfile = {
  defaultProfile: 'Default',
  startDate: '2026-03-16T16:00:00.000Z',
  mills: '1773856800000',
  units: 'mmol/L',
  enteredBy: 'Loop',
  loopSettings: {
    dosingEnabled: true,
    dosingStrategy: 'tempBasalOnly',
    overridePresets: [],
    maximumBasalRatePerHour: 4.0,
    maximumBolus: 8.0
  },
  store: {
    Default: {
      dia: 5,
      carbs_hr: '0',
      delay: '0',
      timezone: 'ETC/GMT+0',
      target_low: [scheduleItem(0, 0, 5.5)],
      target_high: [scheduleItem(0, 0, 6.0)],
      sens: [scheduleItem(0, 0, 2.5)],
      basal: [scheduleItem(0, 0, 0.9)],
      carbratio: [scheduleItem(0, 0, 10)],
      units: 'mmol/L'
    }
  }
};

// Second profile for batch upload testing
const secondProfile = {
  defaultProfile: 'Default',
  startDate: '2026-03-16T17:00:00.000Z',
  mills: '1773860400000',
  units: 'mg/dl',
  enteredBy: 'Loop',
  loopSettings: {
    dosingEnabled: true,
    overridePresets: [],
    maximumBasalRatePerHour: 6.0,
    maximumBolus: 12.0
  },
  store: {
    Default: {
      dia: 6,
      carbs_hr: '0',
      delay: '0',
      timezone: 'ETC/GMT+5',
      target_low: [scheduleItem(0, 0, 90)],
      target_high: [scheduleItem(0, 0, 100)],
      sens: [scheduleItem(0, 0, 50)],
      basal: [scheduleItem(0, 0, 1.1)],
      carbratio: [scheduleItem(0, 0, 11)],
      units: 'mg/dl'
    }
  }
};

module.exports = {
  // Individual profile objects
  minimal: minimalProfile,
  fullLoop: fullLoopProfile,
  withActiveOverride: profileWithActiveOverride,
  mmol: mmolProfile,
  second: secondProfile,

  // ============================================================
  // ARRAY FORMATS - What NightscoutKit actually sends to POST /api/v1/profile
  // ============================================================

  // Single profile wrapped in array (most common case)
  // NightscoutClient.uploadProfile() sends: [profileSet.dictionaryRepresentation]
  singleArray: [minimalProfile],

  // Full Loop profile as array
  fullLoopArray: [fullLoopProfile],

  // Profile with active override as array
  withOverrideArray: [profileWithActiveOverride],

  // Batch upload: multiple profiles in single request
  // NightscoutClient.uploadProfiles() sends: profileSets.map { $0.dictionaryRepresentation }
  // Used when Loop syncs historical settings (up to 400 per batch!)
  batchArray: [minimalProfile, fullLoopProfile, secondProfile],

  // Two-profile batch for simpler testing
  twoProfileBatch: [minimalProfile, secondProfile],

  // ============================================================
  // EXPECTED RESPONSES
  // ============================================================

  // NightscoutKit expects array response with _id fields
  // Response.count MUST equal input.count
  expectedResponseFormat: {
    description: 'NightscoutKit expects: postResponse as? [[String: Any]], insertedEntries.count == json.count',
    example: [
      { _id: '507f1f77bcf86cd799439011', ...minimalProfile, created_at: '2026-03-18T17:00:00.000Z' }
    ]
  },

  // ============================================================
  // HELPERS
  // ============================================================
  scheduleItem,

  // Generate unique profile for dedup testing
  generateUniqueProfile: function(suffix) {
    const now = Date.now();
    return {
      defaultProfile: 'Default',
      startDate: new Date(now).toISOString(),
      mills: String(now),
      units: 'mg/dl',
      enteredBy: 'Loop-' + suffix,
      loopSettings: {
        dosingEnabled: true,
        overridePresets: []
      },
      store: {
        Default: {
          dia: 6,
          carbs_hr: '0',
          delay: '0',
          timezone: 'ETC/GMT+5',
          target_low: [scheduleItem(0, 0, 100)],
          target_high: [scheduleItem(0, 0, 110)],
          sens: [scheduleItem(0, 0, 45)],
          basal: [scheduleItem(0, 0, 1.0)],
          carbratio: [scheduleItem(0, 0, 10)],
          units: 'mg/dl'
        }
      }
    };
  }
};
