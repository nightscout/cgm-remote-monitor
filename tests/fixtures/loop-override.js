'use strict';

/**
 * Loop Override Test Fixtures for GAP-TREAT-012 Testing
 * 
 * GAP-TREAT-012: v1 API incorrectly coerces UUID _id to ObjectId
 * 
 * This file provides fixtures that simulate real Loop override uploads,
 * which use UUID strings as the `id` field (mapped to `_id` in Nightscout).
 * 
 * REQ-SYNC-072: UUID _id should be moved to identifier field,
 * with server generating a valid ObjectId for _id.
 */

// Generate fresh dates for each test run
function now() {
  return new Date().toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

module.exports = {
  /**
   * Standard Loop override as uploaded by OverrideTreatment.swift
   * Note: Loop sends `id` as UUID string, NOT as ObjectId
   */
  standardOverride: {
    _id: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
    eventType: 'Temporary Override',
    created_at: minutesAgo(30),
    enteredBy: 'Loop',
    duration: 60,
    correctionRange: [90, 110],
    insulinNeedsScaleFactor: 1.2,
    reason: 'Custom Override'
  },

  /**
   * Indefinite override (no end time)
   */
  indefiniteOverride: {
    _id: 'B2C3D4E5-F6A7-8901-BCDE-F23456789012',
    eventType: 'Temporary Override',
    created_at: minutesAgo(15),
    enteredBy: 'Loop',
    durationType: 'indefinite',
    correctionRange: [100, 120],
    insulinNeedsScaleFactor: 1.0,
    reason: 'Running Low'
  },

  /**
   * Remote command override
   */
  remoteOverride: {
    _id: 'C3D4E5F6-A7B8-9012-CDEF-345678901234',
    eventType: 'Temporary Override',
    created_at: minutesAgo(5),
    enteredBy: 'Loop (via remote command)',
    duration: 120,
    correctionRange: [150, 180],
    insulinNeedsScaleFactor: 0.5,
    reason: 'Workout'
  },

  /**
   * Preset override (e.g., "Eating Soon")
   */
  presetOverride: {
    _id: 'D4E5F6A7-B8C9-0123-DEFA-456789012345',
    eventType: 'Temporary Override',
    created_at: hoursAgo(1),
    enteredBy: 'Loop',
    duration: 60,
    correctionRange: [80, 80],
    insulinNeedsScaleFactor: 1.0,
    reason: 'Pre-Meal'
  },

  /**
   * Update scenario: same UUID, different values
   */
  updateScenario: {
    original: {
      _id: 'E5F6A7B8-C9D0-1234-EFAB-567890123456',
      eventType: 'Temporary Override',
      created_at: hoursAgo(2),
      enteredBy: 'Loop',
      duration: 60,
      correctionRange: [100, 120],
      insulinNeedsScaleFactor: 1.0,
      reason: 'Original Override'
    },
    updated: {
      _id: 'E5F6A7B8-C9D0-1234-EFAB-567890123456',
      eventType: 'Temporary Override',
      created_at: hoursAgo(1),
      enteredBy: 'Loop',
      duration: 120,  // Extended duration
      correctionRange: [110, 130],  // Changed range
      insulinNeedsScaleFactor: 0.8,  // Changed factor
      reason: 'Updated Override'
    }
  },

  /**
   * Delete scenario: override to cancel
   */
  deleteScenario: {
    toDelete: {
      _id: 'F6A7B8C9-D0E1-2345-FABC-678901234567',
      eventType: 'Temporary Override',
      created_at: minutesAgo(45),
      enteredBy: 'Loop',
      duration: 90,
      correctionRange: [95, 115],
      insulinNeedsScaleFactor: 1.1,
      reason: 'To Be Deleted'
    }
  },

  /**
   * Multiple overrides batch (simulates Loop restart/sync)
   */
  batchOverrides: [
    {
      _id: '11111111-1111-1111-1111-111111111111',
      eventType: 'Temporary Override',
      created_at: hoursAgo(3),
      enteredBy: 'Loop',
      duration: 30,
      correctionRange: [90, 100],
      insulinNeedsScaleFactor: 1.0,
      reason: 'First Override'
    },
    {
      _id: '22222222-2222-2222-2222-222222222222',
      eventType: 'Temporary Override',
      created_at: hoursAgo(2),
      enteredBy: 'Loop',
      duration: 45,
      correctionRange: [100, 110],
      insulinNeedsScaleFactor: 0.9,
      reason: 'Second Override'
    },
    {
      _id: '33333333-3333-3333-3333-333333333333',
      eventType: 'Temporary Override',
      created_at: hoursAgo(1),
      enteredBy: 'Loop',
      duration: 60,
      correctionRange: [80, 90],
      insulinNeedsScaleFactor: 1.2,
      reason: 'Third Override'
    }
  ],

  /**
   * Duplicate detection scenario
   * Same UUID should NOT create duplicate
   */
  duplicateScenario: {
    first: {
      _id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      eventType: 'Temporary Override',
      created_at: minutesAgo(60),
      enteredBy: 'Loop',
      duration: 60,
      correctionRange: [100, 110],
      insulinNeedsScaleFactor: 1.0,
      reason: 'Original Post'
    },
    repost: {
      _id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      eventType: 'Temporary Override',
      created_at: minutesAgo(30),  // Different time
      enteredBy: 'Loop',
      duration: 90,  // Different duration
      correctionRange: [110, 120],
      insulinNeedsScaleFactor: 1.1,
      reason: 'Reposted Override'
    }
  },

  /**
   * Mixed eventTypes batch - some with UUID, some without
   */
  mixedBatch: [
    {
      _id: 'UUID1234-5678-90AB-CDEF-111111111111',
      eventType: 'Temporary Override',
      created_at: minutesAgo(20),
      enteredBy: 'Loop',
      duration: 60,
      correctionRange: [100, 110],
      insulinNeedsScaleFactor: 1.0,
      reason: 'Override With UUID'
    },
    {
      eventType: 'Carb Correction',
      carbs: 15,
      created_at: minutesAgo(15),
      enteredBy: 'loop://iPhone',
      absorptionTime: 180
    },
    {
      eventType: 'Bolus',
      insulin: 2.5,
      created_at: minutesAgo(10),
      enteredBy: 'loop://iPhone'
    }
  ]
};
