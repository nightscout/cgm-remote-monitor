'use strict';

/**
 * NightscoutKit DeviceStatus Fixtures
 * 
 * Extracted from NightscoutKit Swift source:
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/DeviceStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/LoopStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/PumpStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/IOBStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/COBStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/PredictedBG.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/LoopEnacted.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/UploaderStatus.swift
 *   - externals/NightscoutKit/Sources/NightscoutKit/Models/BatteryStatus.swift
 * 
 * NightscoutKit sends devicestatus as arrays (see NightscoutClient.swift:646-647):
 *   postToNS(deviceStatuses.map { $0.dictionaryRepresentation }, endpoint: .deviceStatus, ...)
 */

const BASE_TIME = '2026-03-18T17:00:00.000Z';
const BASE_TIME_MS = 1773861600000;

// Helper: Generate ISO timestamp offset from BASE_TIME
function timestamp(minutesOffset = 0) {
  return new Date(BASE_TIME_MS + minutesOffset * 60 * 1000).toISOString();
}

// ============================================================
// IOBStatus - from IOBStatus.swift:24-38
// ============================================================
function iobStatus(ts, iob, basalIOB = null) {
  const result = {
    timestamp: ts,
    iob: iob
  };
  if (basalIOB !== null) {
    result.basaliob = basalIOB;
  }
  return result;
}

// ============================================================
// COBStatus - from COBStatus.swift:22-28
// ============================================================
function cobStatus(ts, cob) {
  return {
    timestamp: ts,
    cob: cob
  };
}

// ============================================================
// PredictedBG - from PredictedBG.swift:30-44
// Values are in mg/dL, 5-minute intervals
// ============================================================
function predictedBG(startDate, values, cobValues = null, iobValues = null) {
  const result = {
    startDate: startDate,
    values: values
  };
  if (cobValues) {
    result.COB = cobValues;
  }
  if (iobValues) {
    result.IOB = iobValues;
  }
  return result;
}

// ============================================================
// LoopEnacted - from LoopEnacted.swift:28-39
// duration is in MINUTES in the JSON (converted from TimeInterval)
// ============================================================
function loopEnacted(ts, rate, durationMinutes, received, bolusVolume = 0) {
  return {
    rate: rate,
    duration: durationMinutes,
    timestamp: ts,
    received: received,
    bolusVolume: bolusVolume
  };
}

// ============================================================
// BatteryStatus - from BatteryStatus.swift:28-43
// ============================================================
function batteryStatus(percent = null, voltage = null, status = null) {
  const result = {};
  if (percent !== null) result.percent = percent;
  if (voltage !== null) result.voltage = voltage;
  if (status !== null) result.status = status; // 'low' or 'normal'
  return result;
}

// ============================================================
// PumpStatus - from PumpStatus.swift:49-66
// ============================================================
function pumpStatus(clock, pumpID, options = {}) {
  const result = {
    clock: clock,
    pumpID: pumpID
  };
  if (options.manufacturer) result.manufacturer = options.manufacturer;
  if (options.model) result.model = options.model;
  if (options.iob) result.iob = options.iob;
  if (options.battery) result.battery = options.battery;
  if (options.suspended !== undefined) result.suspended = options.suspended;
  if (options.bolusing !== undefined) result.bolusing = options.bolusing;
  if (options.reservoir !== undefined) result.reservoir = options.reservoir;
  if (options.secondsFromGMT !== undefined) result.secondsFromGMT = options.secondsFromGMT;
  if (options.reservoirDisplayOverride) result.reservoir_display_override = options.reservoirDisplayOverride;
  if (options.reservoirLevelOverride !== undefined) result.reservoir_level_override = options.reservoirLevelOverride;
  return result;
}

// ============================================================
// UploaderStatus - from UploaderStatus.swift:34-45
// ============================================================
function uploaderStatus(name, ts, battery = null) {
  const result = {
    name: name,
    timestamp: ts
  };
  if (battery !== null) result.battery = battery;
  return result;
}

// ============================================================
// LoopStatus - from LoopStatus.swift:48-99
// The main Loop algorithm status object
// ============================================================
function loopStatus(name, version, ts, options = {}) {
  const result = {
    name: name,
    version: version,
    timestamp: ts
  };
  if (options.iob) result.iob = options.iob;
  if (options.cob) result.cob = options.cob;
  if (options.predicted) result.predicted = options.predicted;
  if (options.automaticDoseRecommendation) result.automaticDoseRecommendation = options.automaticDoseRecommendation;
  if (options.recommendedBolus !== undefined) result.recommendedBolus = options.recommendedBolus;
  if (options.enacted) result.enacted = options.enacted;
  if (options.rileylinks) result.rileylinks = options.rileylinks;
  if (options.failureReason) result.failureReason = options.failureReason;
  if (options.currentCorrectionRange) result.currentCorrectionRange = options.currentCorrectionRange;
  if (options.forecastError) result.forecastError = options.forecastError;
  if (options.testingDetails) result.testingDetails = options.testingDetails;
  return result;
}

// ============================================================
// DeviceStatus - from DeviceStatus.swift:34-65
// The top-level devicestatus document
// ============================================================
function deviceStatus(device, ts, options = {}) {
  const result = {
    device: device,
    created_at: ts
  };
  if (options.pump) result.pump = options.pump;
  if (options.uploader) result.uploader = options.uploader;
  if (options.loop) result.loop = options.loop;
  if (options.radioAdapter) result.radioAdapter = options.radioAdapter;
  if (options.override) result.override = options.override;
  if (options.identifier) result.identifier = options.identifier;
  return result;
}

// ============================================================
// EXAMPLE FIXTURES
// ============================================================

// Minimal devicestatus - just device and timestamp
const minimalStatus = deviceStatus('loop://iPhone', timestamp(0));

// Loop devicestatus with IOB/COB
const loopWithIOBCOB = deviceStatus('loop://iPhone', timestamp(0), {
  uploader: uploaderStatus('iPhone', timestamp(0), 85),
  loop: loopStatus('Loop', '3.4.1', timestamp(0), {
    iob: iobStatus(timestamp(0), 2.5, 0.8),
    cob: cobStatus(timestamp(0), 25)
  })
});

// Full Loop devicestatus with predictions
const fullLoopStatus = deviceStatus('loop://iPhone', timestamp(0), {
  identifier: 'abc123-def456-ghi789',
  uploader: uploaderStatus('iPhone', timestamp(0), 72),
  pump: pumpStatus(timestamp(0), 'ABCD1234', {
    manufacturer: 'Insulet',
    model: 'Dash',
    iob: iobStatus(timestamp(0), 2.5, 0.8),
    battery: batteryStatus(null, null, 'normal'),
    suspended: false,
    bolusing: false,
    reservoir: 125.5,
    secondsFromGMT: -18000
  }),
  loop: loopStatus('Loop', '3.4.1', timestamp(0), {
    iob: iobStatus(timestamp(0), 2.5, 0.8),
    cob: cobStatus(timestamp(0), 25),
    predicted: predictedBG(timestamp(0), [
      120, 118, 115, 112, 110, 108, 106, 104, 102, 100, 98, 96
    ]),
    enacted: loopEnacted(timestamp(-5), 1.2, 30, true),
    recommendedBolus: 0,
    currentCorrectionRange: { minValue: 100, maxValue: 110 }
  })
});

// Loop with enacted temp basal
const loopWithEnacted = deviceStatus('loop://iPhone', timestamp(-5), {
  uploader: uploaderStatus('iPhone', timestamp(-5), 90),
  loop: loopStatus('Loop', '3.4.1', timestamp(-5), {
    iob: iobStatus(timestamp(-5), 1.8, 0.5),
    cob: cobStatus(timestamp(-5), 0),
    enacted: loopEnacted(timestamp(-5), 0.8, 30, true),
    predicted: predictedBG(timestamp(-5), [
      105, 102, 100, 98, 96, 95, 94, 93, 92, 91, 90
    ])
  })
});

// Loop with failure
const loopWithFailure = deviceStatus('loop://iPhone', timestamp(-10), {
  uploader: uploaderStatus('iPhone', timestamp(-10), 65),
  loop: loopStatus('Loop', '3.4.1', timestamp(-10), {
    failureReason: 'Pump communication timeout'
  })
});

// Loop with automatic bolus recommendation
const loopWithAutoBolus = deviceStatus('loop://iPhone', timestamp(0), {
  uploader: uploaderStatus('iPhone', timestamp(0), 80),
  loop: loopStatus('Loop', '3.4.1', timestamp(0), {
    iob: iobStatus(timestamp(0), 3.2, 1.0),
    cob: cobStatus(timestamp(0), 45),
    predicted: predictedBG(timestamp(0), [
      145, 150, 155, 158, 160, 158, 155, 150, 145, 140
    ]),
    automaticDoseRecommendation: {
      bolusUnits: 0.5,
      basalAdjustment: { rate: 2.5, duration: 30 }
    },
    recommendedBolus: 2.0
  })
});

// Loop with multiple prediction curves (COB, IOB)
const loopWithMultiplePredictions = deviceStatus('loop://iPhone', timestamp(0), {
  uploader: uploaderStatus('iPhone', timestamp(0), 88),
  loop: loopStatus('Loop', '3.4.1', timestamp(0), {
    iob: iobStatus(timestamp(0), 2.0, 0.6),
    cob: cobStatus(timestamp(0), 30),
    predicted: predictedBG(timestamp(0),
      [120, 125, 130, 128, 125, 120, 115, 110, 105, 100], // values (combined)
      [120, 130, 140, 145, 140, 135, 125, 115, 105, 95],  // COB curve
      [120, 118, 115, 112, 110, 108, 106, 104, 102, 100]  // IOB curve
    ),
    enacted: loopEnacted(timestamp(-5), 1.5, 30, true)
  })
});

// Second status for batch testing (different timestamp)
const secondStatus = deviceStatus('loop://iPhone', timestamp(-15), {
  uploader: uploaderStatus('iPhone', timestamp(-15), 75),
  loop: loopStatus('Loop', '3.4.1', timestamp(-15), {
    iob: iobStatus(timestamp(-15), 1.5, 0.4),
    cob: cobStatus(timestamp(-15), 10)
  })
});

module.exports = {
  // Helper functions for building custom fixtures
  helpers: {
    timestamp,
    iobStatus,
    cobStatus,
    predictedBG,
    loopEnacted,
    batteryStatus,
    pumpStatus,
    uploaderStatus,
    loopStatus,
    deviceStatus
  },

  // Individual devicestatus objects
  minimal: minimalStatus,
  loopWithIOBCOB: loopWithIOBCOB,
  fullLoop: fullLoopStatus,
  withEnacted: loopWithEnacted,
  withFailure: loopWithFailure,
  withAutoBolus: loopWithAutoBolus,
  withMultiplePredictions: loopWithMultiplePredictions,
  second: secondStatus,

  // ============================================================
  // ARRAY FORMATS - What NightscoutKit actually sends to POST /api/v1/devicestatus
  // ============================================================

  // Single devicestatus in array
  singleArray: [minimalStatus],

  // Full Loop status in array
  fullLoopArray: [fullLoopStatus],

  // Devicestatus with enacted temp in array
  withEnactedArray: [loopWithEnacted],

  // Batch upload: multiple devicestatuses in single request
  batchArray: [loopWithIOBCOB, loopWithEnacted, secondStatus],

  // Two-status batch for simpler testing
  twoStatusBatch: [loopWithIOBCOB, secondStatus],

  // ============================================================
  // EXPECTED RESPONSES
  // ============================================================

  expectedResponseFormat: {
    description: 'NightscoutKit expects array response with _id fields',
    example: [
      { _id: '507f1f77bcf86cd799439011', ...minimalStatus, srvCreated: Date.now() }
    ]
  },

  // ============================================================
  // SPECIAL CASES
  // ============================================================

  // Generate unique devicestatus for dedup testing
  generateUniqueStatus: function(suffix) {
    const now = Date.now();
    const ts = new Date(now).toISOString();
    return deviceStatus('loop://iPhone-' + suffix, ts, {
      identifier: 'test-' + now + '-' + suffix,
      uploader: uploaderStatus('iPhone', ts, 80),
      loop: loopStatus('Loop', '3.4.1', ts, {
        iob: iobStatus(ts, Math.random() * 5, Math.random() * 2),
        cob: cobStatus(ts, Math.random() * 50)
      })
    });
  }
};
