'use strict';

module.exports = {
  aapsDuplicatePumpId: {
    first: {
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
    duplicate: {
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
    }
  },

  aapsDuplicateEntry: {
    first: {
      type: 'sgv',
      sgv: 120,
      date: Date.now(),
      dateString: new Date().toISOString(),
      device: 'AndroidAPS-DexcomG6',
      direction: 'Flat',
      app: 'AAPS'
    },
    duplicate: {
      type: 'sgv',
      sgv: 120,
      date: Date.now(),
      dateString: new Date().toISOString(),
      device: 'AndroidAPS-DexcomG6',
      direction: 'Flat',
      app: 'AAPS'
    }
  },

  loopDuplicateSyncId: {
    first: {
      eventType: 'Carb Correction',
      carbs: 15,
      syncIdentifier: 'loop-sync-abc123',
      created_at: new Date().toISOString(),
      enteredBy: 'loop://iPhone'
    },
    duplicate: {
      eventType: 'Carb Correction',
      carbs: 15,
      syncIdentifier: 'loop-sync-abc123',
      created_at: new Date().toISOString(),
      enteredBy: 'loop://iPhone'
    }
  },

  loopDuplicateDose: {
    first: {
      eventType: 'Temp Basal',
      duration: 30,
      rate: 1.5,
      absolute: 1.5,
      syncIdentifier: 'loop-dose-xyz789',
      created_at: new Date().toISOString(),
      enteredBy: 'loop://iPhone'
    },
    duplicate: {
      eventType: 'Temp Basal',
      duration: 30,
      rate: 1.5,
      absolute: 1.5,
      syncIdentifier: 'loop-dose-xyz789',
      created_at: new Date().toISOString(),
      enteredBy: 'loop://iPhone'
    }
  },

  trioDuplicateId: {
    first: {
      eventType: 'Meal Bolus',
      id: 'trio-uuid-abc123',
      insulin: 5.0,
      carbs: 45,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    },
    duplicate: {
      eventType: 'Meal Bolus',
      id: 'trio-uuid-abc123',
      insulin: 5.0,
      carbs: 45,
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    }
  },

  trioDuplicateTempTarget: {
    first: {
      eventType: 'Temporary Target',
      id: 'trio-tt-def456',
      duration: 60,
      targetTop: 110,
      targetBottom: 110,
      reason: 'Eating Soon',
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    },
    duplicate: {
      eventType: 'Temporary Target',
      id: 'trio-tt-def456',
      duration: 60,
      targetTop: 110,
      targetBottom: 110,
      reason: 'Eating Soon',
      created_at: new Date().toISOString(),
      enteredBy: 'Trio'
    }
  },

  expectedDeduplicationResponse: {
    v3Api: {
      identifier: '60ed782dc574da0004a38595',
      isDeduplication: true,
      deduplicatedIdentifier: '60ed782dc574da0004a38595',
      lastModified: 1705579200000
    },
    v1Api: {
      _id: '60ed782dc574da0004a38595',
      ok: 1,
      n: 0,
      nModified: 0
    }
  },

  batchWithDuplicates: [
    { eventType: 'Note', created_at: new Date().toISOString(), notes: 'First note', id: 'note-1' },
    { eventType: 'Note', created_at: new Date(Date.now() + 60000).toISOString(), notes: 'Second note', id: 'note-2' },
    { eventType: 'Note', created_at: new Date().toISOString(), notes: 'First note', id: 'note-1' },
    { eventType: 'Note', created_at: new Date(Date.now() + 120000).toISOString(), notes: 'Third note', id: 'note-3' }
  ],

  crossClientDuplicates: {
    aapsUpload: {
      eventType: 'Correction Bolus',
      insulin: 0.25,
      pumpId: 4148,
      pumpType: 'OMNIPOD_DASH',
      pumpSerial: 'PDM-12345',
      app: 'AAPS'
    },
    trioUploadSameEvent: {
      eventType: 'Correction Bolus',
      insulin: 0.25,
      id: 'trio-smb-4148',
      enteredBy: 'Trio'
    }
  }
};
