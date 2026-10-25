'use strict';

/**
 * Entry UUID Handling Tests
 * 
 * Tests for GAP-SYNC-045: Trio uploads CGM entries with UUID as _id
 * 
 * Phase 0: Baseline tests document current sysTime+type dedup behavior
 * Phase 1: UUID _id handling tests (to be implemented after baseline passes)
 * 
 * @see docs/backlogs/trio-entries-upload-testing.md
 * @see traceability/sync-identity-gaps.md#gap-sync-045
 */

var request = require('supertest');
var bootevent = require('../lib/server/bootevent');
var language = require('../lib/language')();

require('should');

describe('Entry sysTime+type dedup (Baseline)', function() {
  var entries = require('../lib/api/entries/');
  var self = this;
  // SHA1 hash of 'this is my long pass phrase'
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  
  this.timeout(10000);
  
  before(function(done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    bootevent(self.env, language).boot(function booted(ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx, self.env));
      self.archive = require('../lib/server/entries')(self.env, ctx);
      self.ctx = ctx;
      self.known = known;
      done();
    });
  });
  
  afterEach(async function() {
    await self.archive().deleteMany({});
  });
  
  after(async function() {
    await self.archive().deleteMany({});
  });
  
  /**
   * TEST-ENTRY-DEDUP-001: Re-POST same sysTime+type updates existing entry
   * 
   * CRITICAL: This documents production behavior that prevents duplicate CGM data.
   * The sysTime+type upsert ensures only one SGV per timestamp.
   */
  it('TEST-ENTRY-DEDUP-001: re-POST same sysTime+type updates existing entry', function(done) {
    var timestamp = Date.now();
    var dateString = new Date(timestamp).toISOString();
    
    var entry1 = {
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: dateString,
      device: 'TestDevice'
    };
    
    var entry2 = {
      type: 'sgv',
      sgv: 125, // Different value, same timestamp
      direction: 'FortyFiveUp',
      date: timestamp,
      dateString: dateString,
      device: 'TestDevice'
    };
    
    // First POST
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry1)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Second POST with same timestamp
        request(self.app)
          .post('/entries/')
          .set('api-secret', self.known)
          .send(entry2)
          .expect(200)
          .end(function(err2, res2) {
            if (err2) return done(err2);
            
            // Verify: only 1 entry exists with updated sgv 125
            self.archive().find({ date: timestamp }).toArray()
              .then(function(docs) {
                docs.should.have.lengthOf(1);
                docs[0].sgv.should.equal(125);
                docs[0].direction.should.equal('FortyFiveUp');
                done();
              })
              .catch(done);
          });
      });
  });
  
  /**
   * TEST-ENTRY-DEDUP-002: Different type at same sysTime creates second entry
   * 
   * SGV and MBG entries at same timestamp should both be preserved.
   */
  it('TEST-ENTRY-DEDUP-002: different type at same sysTime creates second entry', function(done) {
    var timestamp = Date.now();
    var dateString = new Date(timestamp).toISOString();
    
    var sgvEntry = {
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: dateString,
      device: 'CGM'
    };
    
    var mbgEntry = {
      type: 'mbg',
      mbg: 115,
      date: timestamp,
      dateString: dateString,
      device: 'Meter'
    };
    
    // POST SGV
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(sgvEntry)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // POST MBG at same timestamp
        request(self.app)
          .post('/entries/')
          .set('api-secret', self.known)
          .send(mbgEntry)
          .expect(200)
          .end(function(err2, res2) {
            if (err2) return done(err2);
            
            // Verify: 2 entries exist (different types)
            self.archive().find({ date: timestamp }).toArray()
              .then(function(docs) {
                docs.should.have.lengthOf(2);
                var types = docs.map(d => d.type).sort();
                types.should.eql(['mbg', 'sgv']);
                done();
              })
              .catch(done);
          });
      });
  });
  
  /**
   * TEST-ENTRY-DEDUP-003: Different sysTime with same type creates second entry
   * 
   * SGV entries at different timestamps should both be preserved.
   */
  it('TEST-ENTRY-DEDUP-003: different sysTime with same type creates second entry', function(done) {
    var timestamp1 = Date.now();
    var timestamp2 = timestamp1 + 300000; // 5 minutes later
    
    var entry1 = {
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp1,
      dateString: new Date(timestamp1).toISOString(),
      device: 'TestDevice'
    };
    
    var entry2 = {
      type: 'sgv',
      sgv: 130,
      direction: 'FortyFiveUp',
      date: timestamp2,
      dateString: new Date(timestamp2).toISOString(),
      device: 'TestDevice'
    };
    
    // POST first entry
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry1)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // POST second entry at different timestamp
        request(self.app)
          .post('/entries/')
          .set('api-secret', self.known)
          .send(entry2)
          .expect(200)
          .end(function(err2, res2) {
            if (err2) return done(err2);
            
            // Verify: 2 entries exist
            self.archive().find({ type: 'sgv', date: { $in: [timestamp1, timestamp2] } }).toArray()
              .then(function(docs) {
                docs.should.have.lengthOf(2);
                done();
              })
              .catch(done);
          });
      });
  });
});

describe('Entry UUID _id handling (GAP-SYNC-045)', function() {
  var entries = require('../lib/api/entries/');
  var self = this;
  // SHA1 hash of 'this is my long pass phrase'
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  
  this.timeout(10000);
  
  before(function(done) {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    bootevent(self.env, language).boot(function booted(ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx, self.env));
      self.archive = require('../lib/server/entries')(self.env, ctx);
      self.ctx = ctx;
      self.known = known;
      done();
    });
  });
  
  afterEach(async function() {
    await self.archive().deleteMany({});
  });
  
  after(async function() {
    await self.archive().deleteMany({});
  });
  
  /**
   * TEST-ENTRY-UUID-001: POST Entry with UUID _id
   * 
   * Trio uploads entries with UUID as _id (from sample.syncIdentifier).
   * Entry should be created successfully.
   */
  it('TEST-ENTRY-UUID-001: accepts UUID _id on POST', function(done) {
    var uuid = '550e8400-e29b-41d4-a716-446655440000';
    var timestamp = Date.now();
    
    var entry = {
      _id: uuid,
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: new Date(timestamp).toISOString(),
      device: 'Trio'
    };
    
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Entry should be created (may have ObjectId _id, UUID in identifier)
        self.archive().find({ date: timestamp }).toArray()
          .then(function(docs) {
            docs.should.have.lengthOf(1);
            docs[0].sgv.should.equal(120);
            // Note: After fix, expect docs[0].identifier === uuid
            done();
          })
          .catch(done);
      });
  });
  
  /**
   * TEST-ENTRY-UUID-002: Re-POST same UUID deduplicates by sysTime+type
   * 
   * Current behavior: sysTime+type is the dedup key, not _id.
   * Re-uploading same entry should update, not create duplicate.
   */
  it('TEST-ENTRY-UUID-002: re-POST same UUID deduplicates by sysTime+type', function(done) {
    var uuid = '550e8400-e29b-41d4-a716-446655440001';
    var timestamp = Date.now();
    var dateString = new Date(timestamp).toISOString();
    
    var entry1 = {
      _id: uuid,
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: dateString,
      device: 'Trio'
    };
    
    var entry2 = {
      _id: uuid,
      type: 'sgv',
      sgv: 125, // Updated value
      direction: 'FortyFiveUp',
      date: timestamp,
      dateString: dateString,
      device: 'Trio'
    };
    
    // First POST
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry1)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Re-POST with same UUID and timestamp
        request(self.app)
          .post('/entries/')
          .set('api-secret', self.known)
          .send(entry2)
          .expect(200)
          .end(function(err2, res2) {
            if (err2) return done(err2);
            
            // Verify: single entry, updated value
            self.archive().find({ date: timestamp }).toArray()
              .then(function(docs) {
                docs.should.have.lengthOf(1);
                docs[0].sgv.should.equal(125);
                done();
              })
              .catch(done);
          });
      });
  });
  
  /**
   * TEST-ENTRY-UUID-003: Re-POST different UUID same timestamp deduplicates
   * 
   * CRITICAL: Different UUID at same timestamp should still deduplicate.
   * This prevents duplicate CGM readings from app reinstalls.
   * 
   * Fixed by GAP-SYNC-045: normalizeEntryId() extracts UUID to identifier,
   * upsertQueryFor() strips non-ObjectId _id before $set operation.
   */
  it('TEST-ENTRY-UUID-003: re-POST different UUID same timestamp deduplicates', function(done) {
    var uuid1 = '550e8400-e29b-41d4-a716-446655440002';
    var uuid2 = '550e8400-e29b-41d4-a716-446655440003'; // Different UUID
    var timestamp = Date.now();
    var dateString = new Date(timestamp).toISOString();
    
    var entry1 = {
      _id: uuid1,
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: dateString,
      device: 'Trio'
    };
    
    var entry2 = {
      _id: uuid2, // Different UUID
      type: 'sgv',
      sgv: 125,
      direction: 'FortyFiveUp',
      date: timestamp,
      dateString: dateString,
      device: 'Trio'
    };
    
    // First POST
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry1)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Re-POST with different UUID but same timestamp
        request(self.app)
          .post('/entries/')
          .set('api-secret', self.known)
          .send(entry2)
          .expect(200)
          .end(function(err2, res2) {
            if (err2) return done(err2);
            
            // Verify: single entry (dedup by sysTime+type, not UUID)
            self.archive().find({ date: timestamp }).toArray()
              .then(function(docs) {
                docs.should.have.lengthOf(1);
                docs[0].sgv.should.equal(125);
                done();
              })
              .catch(done);
          });
      });
  });
  
  /**
   * TEST-ENTRY-UUID-004: Batch upload with mixed IDs
   * 
   * Batch containing ObjectId, UUID, and no _id should all succeed.
   */
  it('TEST-ENTRY-UUID-004: batch upload handles mixed IDs', function(done) {
    var timestamp1 = Date.now();
    var timestamp2 = timestamp1 + 300000;
    var timestamp3 = timestamp1 + 600000;
    
    var batch = [
      {
        _id: '507f1f77bcf86cd799439011', // Valid ObjectId hex string
        type: 'sgv',
        sgv: 120,
        date: timestamp1,
        dateString: new Date(timestamp1).toISOString(),
        device: 'Test'
      },
      {
        _id: '550e8400-e29b-41d4-a716-446655440004', // UUID
        type: 'sgv',
        sgv: 125,
        date: timestamp2,
        dateString: new Date(timestamp2).toISOString(),
        device: 'Trio'
      },
      {
        // No _id
        type: 'sgv',
        sgv: 130,
        date: timestamp3,
        dateString: new Date(timestamp3).toISOString(),
        device: 'xDrip+'
      }
    ];
    
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(batch)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Verify: all 3 entries created
        self.archive().find({ date: { $in: [timestamp1, timestamp2, timestamp3] } }).toArray()
          .then(function(docs) {
            docs.should.have.lengthOf(3);
            var sgvValues = docs.map(d => d.sgv).sort();
            sgvValues.should.eql([120, 125, 130]);
            done();
          })
          .catch(done);
      });
  });
  
  /**
   * TEST-ENTRY-UUID-005: Existing UUID _id entry updated without duplicate
   * 
   * Pre-existing entry with UUID _id should be updated by re-POST,
   * not create a duplicate.
   */
  it('TEST-ENTRY-UUID-005: existing UUID _id entry updated without duplicate', function(done) {
    var uuid = '550e8400-e29b-41d4-a716-446655440005';
    var timestamp = Date.now();
    var sysTime = new Date(timestamp).toISOString();
    
    // Directly insert entry with UUID _id (simulates pre-fix data)
    self.archive().insertOne({
      _id: uuid,
      type: 'sgv',
      sgv: 120,
      date: timestamp,
      dateString: sysTime,
      sysTime: sysTime,
      device: 'Trio'
    }).then(function() {
      // POST via API with same timestamp
      var entry = {
        _id: uuid,
        type: 'sgv',
        sgv: 125, // Updated value
        direction: 'FortyFiveUp',
        date: timestamp,
        dateString: sysTime,
        device: 'Trio'
      };

      request(self.app)
        .post('/entries/')
        .set('api-secret', self.known)
        .send(entry)
        .expect(200)
        .end(function(err2, res) {
          if (err2) return done(err2);

          // Verify: single entry, updated value
          self.archive().find({ date: timestamp }).toArray()
            .then(function(docs) {
              docs.should.have.lengthOf(1);
              docs[0].sgv.should.equal(125);
              done();
            })
            .catch(done);
        });
    }).catch(done);
  });
  
  /**
   * TEST-ENTRY-UUID-006: identifier field preserved after update
   * 
   * After fix: UUID should be stored in identifier field and preserved.
   */
  it('TEST-ENTRY-UUID-006: identifier field preserved after update', function(done) {
    var uuid = '550e8400-e29b-41d4-a716-446655440006';
    var timestamp = Date.now();
    var dateString = new Date(timestamp).toISOString();
    
    var entry = {
      _id: uuid,
      type: 'sgv',
      sgv: 120,
      direction: 'Flat',
      date: timestamp,
      dateString: dateString,
      device: 'Trio'
    };
    
    request(self.app)
      .post('/entries/')
      .set('api-secret', self.known)
      .send(entry)
      .expect(200)
      .end(function(err, res) {
        if (err) return done(err);
        
        // Verify: entry has identifier field with UUID
        self.archive().find({ date: timestamp }).toArray()
          .then(function(docs) {
            docs.should.have.lengthOf(1);
            docs[0].should.have.property('identifier', uuid);
            // _id should be ObjectId, not UUID
            docs[0]._id.should.not.equal(uuid);
            done();
          })
          .catch(done);
      });
  });
});
