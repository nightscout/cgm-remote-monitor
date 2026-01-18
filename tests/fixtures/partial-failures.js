'use strict';

module.exports = {
  batchWithDuplicateKeyInMiddle: {
    input: [
      { eventType: 'Note', created_at: '2024-01-18T12:00:00.000Z', notes: 'First note', id: 'note-unique-1' },
      { eventType: 'Note', created_at: '2024-01-18T12:01:00.000Z', notes: 'Second note', id: 'note-duplicate' },
      { eventType: 'Note', created_at: '2024-01-18T12:02:00.000Z', notes: 'Third note', id: 'note-duplicate' },
      { eventType: 'Note', created_at: '2024-01-18T12:03:00.000Z', notes: 'Fourth note', id: 'note-unique-2' }
    ],
    orderedBehavior: {
      expectedInserted: 2,
      expectedError: 'duplicate key error',
      errorAtIndex: 2,
      stoppedAtIndex: 2,
      documentsAfterIndex2NotInserted: true
    },
    unorderedBehavior: {
      expectedInserted: 3,
      expectedErrors: 1,
      writeErrorsArray: [{ index: 2, code: 11000 }]
    }
  },

  batchWithValidationErrorInMiddle: {
    input: [
      { type: 'sgv', sgv: 120, date: Date.now(), direction: 'Flat' },
      { type: 'sgv', sgv: 'invalid', date: Date.now() + 300000, direction: 'Flat' },
      { type: 'sgv', sgv: 125, date: Date.now() + 600000, direction: 'FortyFiveUp' }
    ],
    orderedBehavior: {
      expectedInserted: 1,
      stoppedAtInvalidDoc: true
    },
    unorderedBehavior: {
      expectedInserted: 2,
      expectedErrors: 1
    }
  },

  loopResponseOrderingScenario: {
    input: [
      { eventType: 'Carb Correction', carbs: 15, syncIdentifier: 'loop-sync-1', created_at: '2024-01-18T12:00:00.000Z' },
      { eventType: 'Carb Correction', carbs: 20, syncIdentifier: 'loop-sync-2', created_at: '2024-01-18T12:01:00.000Z' },
      { eventType: 'Carb Correction', carbs: 25, syncIdentifier: 'loop-sync-3', created_at: '2024-01-18T12:02:00.000Z' }
    ],
    expectedResponseFormat: {
      v1Api: [
        { _id: 'objectId-1', ok: 1 },
        { _id: 'objectId-2', ok: 1 },
        { _id: 'objectId-3', ok: 1 }
      ]
    },
    loopCacheMapping: {
      'loop-sync-1': 'objectId-1',
      'loop-sync-2': 'objectId-2',
      'loop-sync-3': 'objectId-3'
    },
    criticalRequirement: 'Response order MUST match request order for syncIdentifier→objectId mapping'
  },

  loopBatchWithSomeDeduplicated: {
    input: [
      { eventType: 'Carb Correction', carbs: 15, syncIdentifier: 'loop-sync-new', created_at: '2024-01-18T12:00:00.000Z' },
      { eventType: 'Carb Correction', carbs: 20, syncIdentifier: 'loop-sync-exists', created_at: '2024-01-18T12:01:00.000Z' },
      { eventType: 'Carb Correction', carbs: 25, syncIdentifier: 'loop-sync-new2', created_at: '2024-01-18T12:02:00.000Z' }
    ],
    preExisting: [
      { _id: 'existing-objectId', syncIdentifier: 'loop-sync-exists', carbs: 20 }
    ],
    expectedResponse: {
      allItemsPresent: true,
      deduplicatedItemHasOriginalId: true,
      format: [
        { _id: 'new-objectId-1', inserted: true },
        { _id: 'existing-objectId', deduplicated: true },
        { _id: 'new-objectId-2', inserted: true }
      ]
    },
    criticalRequirement: 'Loop expects 3 objectIds back even if middle item is deduplicated'
  },

  clientProvidedIdScenarios: {
    loopWithClientId: {
      input: { 
        eventType: 'Carb Correction', 
        _id: 'client-provided-id-123',
        carbs: 15, 
        created_at: '2024-01-18T12:00:00.000Z' 
      },
      expectedBehavior: 'MongoDB should use client-provided _id if valid ObjectId format',
      riskNote: 'Driver changes may alter _id handling behavior'
    },
    trioWithIdField: {
      input: {
        eventType: 'Meal Bolus',
        id: 'trio-uuid-abc',
        insulin: 5.0,
        created_at: '2024-01-18T12:00:00.000Z'
      },
      expectedBehavior: 'id field is separate from _id, used for deduplication queries',
      note: 'Trio uses id (not _id) for its own tracking'
    },
    aapsWithIdentifier: {
      input: {
        eventType: 'Correction Bolus',
        identifier: 'server-assigned-identifier',
        pumpId: 4148,
        pumpType: 'DANA_R',
        pumpSerial: '12345'
      },
      expectedBehavior: 'identifier is v3 API field, NOT MongoDB _id',
      note: 'v3 API uses identifier field separate from internal _id'
    }
  },

  writeResultFormatChanges: {
    mongodb3xFormat: {
      insertedIds: { '0': 'id1', '1': 'id2' },
      insertedCount: 2,
      acknowledged: true
    },
    mongodb4xFormat: {
      insertedIds: ['id1', 'id2'],
      insertedCount: 2,
      acknowledged: true
    },
    nightscoutV1ExpectedFormat: [
      { _id: 'id1', ok: 1, n: 1 },
      { _id: 'id2', ok: 1, n: 1 }
    ],
    criticalNote: 'Nightscout API layer must translate driver result to expected client format'
  },

  bulkWriteWithMixedOps: {
    operations: [
      { insertOne: { document: { eventType: 'Note', notes: 'new note 1' } } },
      { updateOne: { filter: { _id: 'existing-id' }, update: { $set: { notes: 'updated' } } } },
      { insertOne: { document: { eventType: 'Note', notes: 'new note 2' } } },
      { deleteOne: { filter: { _id: 'to-delete-id' } } }
    ],
    expectedResult: {
      insertedCount: 2,
      modifiedCount: 1,
      deletedCount: 1,
      upsertedCount: 0
    },
    note: 'Complex bulk operations are used internally by Nightscout, clients send simpler requests'
  },

  largeBsonDocumentEdgeCase: {
    deviceStatusWithLargePredictions: {
      device: 'test',
      created_at: new Date().toISOString(),
      openaps: {
        suggested: {
          predBGs: {
            IOB: Array.from({ length: 1000 }, (_, i) => 120 - i * 0.1),
            COB: Array.from({ length: 1000 }, (_, i) => 120 - i * 0.05),
            UAM: Array.from({ length: 1000 }, (_, i) => 120 + i * 0.02),
            ZT: Array.from({ length: 1000 }, (_, i) => 120 - i * 0.08)
          }
        }
      }
    },
    bsonSizeNote: 'Test that predictions arrays do not exceed 16MB BSON limit',
    expectedBehavior: 'Insert should succeed - typical devicestatus is well under limit'
  },

  connectionFailureMidBatch: {
    scenario: 'Network interruption during batch insert',
    input: Array.from({ length: 50 }, (_, i) => ({
      type: 'sgv',
      sgv: 100 + i,
      date: Date.now() + i * 300000
    })),
    possibleOutcomes: {
      allInserted: 'Connection restored before failure',
      partialInsert: 'Some documents inserted before connection lost',
      noneInserted: 'Connection lost before any writes committed'
    },
    clientRecoveryBehavior: {
      loop: 'Will retry entire batch on next sync cycle',
      trio: 'Will retry via throttled pipeline on next trigger',
      aaps: 'Will retry individual document on next sync iteration'
    }
  }
};
