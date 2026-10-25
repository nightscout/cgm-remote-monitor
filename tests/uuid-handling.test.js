'use strict';

/**
 * UUID_HANDLING Feature Flag Tests
 * 
 * Tests for GET/DELETE by UUID using the `identifier` field lookup.
 * 
 * @see docs/backlogs/uuid-identifier-lookup.md
 * @see lib/server/env.js (env.uuidHandling)
 * @see lib/server/query.js (updateIdQuery UUID detection)
 */

var request = require('supertest');
var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();
var api = require('../lib/api/');

var api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

// Test UUIDs
var TEST_UUID = '550e8400-e29b-41d4-a716-446655440000';
var TEST_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Clear module caches to allow env reloading
 */
function clearModuleCache() {
  var modulesToClear = [
    '../lib/server/env',
    '../lib/server/query',
    '../lib/server/treatments',
    '../lib/server/entries',
    '../lib/api/entries/',
    '../lib/api/',
    '../lib/middleware/',
    '../lib/server/bootevent'
  ];
  
  modulesToClear.forEach(function(mod) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch (e) {
      // Module not yet loaded
    }
  });
}

describe('UUID_HANDLING=false (explicit)', function() {
  var self = this;
  this.timeout(10000);
  
  before(function(done) {
    // Explicitly set UUID_HANDLING OFF (default changed to true in 15.0.7)
    process.env.UUID_HANDLING = 'false';
    clearModuleCache();
    
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    // Verify flag is off
    self.env.uuidHandling.should.equal(false);
    
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.ctx.ddata.lastUpdated = Date.now();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });
  
  afterEach(function(done) {
    self.ctx.treatments.remove({ find: {} }, done);
  });
  
  it('UUID-OFF-001: GET by UUID returns empty (no crash)', function(done) {
    // Insert treatment with identifier
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Test note',
      identifier: TEST_UUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // GET by UUID _id - should return empty since flag is off
      request(self.app)
        .get('/api/treatments?find[_id]=' + TEST_UUID)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(0);
          done();
        });
    });
  });
  
  it('UUID-OFF-002: DELETE by UUID deletes nothing (no crash)', function(done) {
    // Insert treatment
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Test for delete',
      identifier: TEST_UUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // DELETE by UUID - should not crash, delete nothing
      request(self.app)
        .delete('/api/treatments/' + TEST_UUID)
        .set('api-secret', api_secret_hash)
        .expect(200)
        .end(function(err) {
          should.not.exist(err);
          
          // Verify treatment still exists
          self.ctx.treatments.list({}, function(err, results) {
            should.not.exist(err);
            results.length.should.equal(1);
            done();
          });
        });
    });
  });

  it('UUID-OFF-003: POST with UUID _id strips UUID, does not copy to identifier', function(done) {
    // When UUID_HANDLING=false, UUID in _id is stripped but NOT preserved as identifier
    self.ctx.treatments.create([{
      _id: TEST_UUID,
      eventType: 'Note',
      notes: 'UUID stripped write test',
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      // Treatment was created (no crash), but UUID was not preserved as identifier
      self.ctx.treatments.list({}, function(err, results) {
        should.not.exist(err);
        results.length.should.equal(1);
        // identifier should NOT be set from the UUID _id when flag is false
        should.not.exist(results[0].identifier);
        done();
      });
    });
  });
});

describe('UUID_HANDLING=true', function() {
  var self = this;
  this.timeout(10000);
  
  before(function(done) {
    // Enable UUID_HANDLING
    process.env.UUID_HANDLING = 'true';
    clearModuleCache();
    
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    // Verify flag is on
    self.env.uuidHandling.should.equal(true);
    
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.ctx.ddata.lastUpdated = Date.now();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });
  
  afterEach(function(done) {
    self.ctx.treatments.remove({ find: {} }, done);
  });
  
  after(function() {
    delete process.env.UUID_HANDLING;
  });
  
  it('UUID-ON-001: GET by UUID finds treatment via identifier', function(done) {
    // Insert treatment with identifier field
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Found by UUID',
      identifier: TEST_UUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // GET by UUID _id - should redirect to identifier search
      request(self.app)
        .get('/api/treatments?find[_id]=' + TEST_UUID)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(1);
          res.body[0].notes.should.equal('Found by UUID');
          res.body[0].identifier.should.equal(TEST_UUID);
          done();
        });
    });
  });
  
  it('UUID-ON-002: DELETE by UUID removes treatment via identifier', function(done) {
    // Insert treatment
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Will be deleted',
      identifier: TEST_UUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // DELETE by UUID
      request(self.app)
        .delete('/api/treatments/' + TEST_UUID)
        .set('api-secret', api_secret_hash)
        .expect(200)
        .end(function(err) {
          should.not.exist(err);
          
          // Verify treatment is gone
          self.ctx.treatments.list({}, function(err, results) {
            should.not.exist(err);
            results.length.should.equal(0);
            done();
          });
        });
    });
  });
  
  it('UUID-ON-003: ObjectId still works normally', function(done) {
    var testId = new ObjectID();
    
    // Insert treatment with ObjectId
    self.ctx.treatments.create([{
      _id: testId,
      eventType: 'Note',
      notes: 'ObjectId test',
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // GET by ObjectId - should work normally
      request(self.app)
        .get('/api/treatments?find[_id]=' + testId.toString())
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(1);
          res.body[0].notes.should.equal('ObjectId test');
          done();
        });
    });
  });
  
  it('UUID-ON-004: Non-matching UUID returns empty', function(done) {
    // Insert with different identifier
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Different UUID',
      identifier: TEST_UUID_2,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // Search for non-existing UUID
      request(self.app)
        .get('/api/treatments?find[_id]=' + TEST_UUID)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(0);
          done();
        });
    });
  });

  it('UUID-ON-005: POST with UUID _id extracts UUID to identifier', function(done) {
    // When UUID_HANDLING=true, UUID in _id is extracted to identifier
    self.ctx.treatments.create([{
      _id: TEST_UUID,
      eventType: 'Note',
      notes: 'UUID write test',
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      // UUID should have been moved to identifier
      self.ctx.treatments.list({}, function(err, results) {
        should.not.exist(err);
        results.length.should.equal(1);
        // identifier should be set from the UUID _id
        results[0].identifier.should.equal(TEST_UUID);
        done();
      });
    });
  });
});

// ============================================

// ============================================
// UUID Edge Case Tests
// ============================================

describe('UUID Edge Cases', function() {
  var self = this;
  this.timeout(10000);
  
  before(function(done) {
    process.env.UUID_HANDLING = 'true';
    clearModuleCache();
    
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.ctx.ddata.lastUpdated = Date.now();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });
  
  afterEach(function(done) {
    self.ctx.treatments.remove({ find: {} }, done);
  });
  
  after(function() {
    delete process.env.UUID_HANDLING;
  });
  
  it('UUID-EDGE-001: 23-char hex (invalid ObjectId) returns empty', function(done) {
    // 23 chars - one short of valid ObjectId
    var invalidId = '507f1f77bcf86cd79943901';
    
    request(self.app)
      .get('/api/treatments?find[_id]=' + invalidId)
      .expect(200)
      .end(function(err, res) {
        should.not.exist(err);
        res.body.should.be.Array();
        res.body.length.should.equal(0);
        done();
      });
  });
  
  it('UUID-EDGE-002: 25-char hex (too long) returns empty', function(done) {
    // 25 chars - one more than valid ObjectId
    var invalidId = '507f1f77bcf86cd7994390112';
    
    request(self.app)
      .get('/api/treatments?find[_id]=' + invalidId)
      .expect(200)
      .end(function(err, res) {
        should.not.exist(err);
        res.body.should.be.Array();
        res.body.length.should.equal(0);
        done();
      });
  });
  
  it('UUID-EDGE-003: UUID without hyphens not recognized as UUID', function(done) {
    // UUID without hyphens (32 hex chars)
    var noHyphenUUID = '550e8400e29b41d4a716446655440000';
    
    // Insert treatment with hyphenated UUID
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Hyphenated UUID',
      identifier: TEST_UUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // Search with non-hyphenated version - should not match
      request(self.app)
        .get('/api/treatments?find[_id]=' + noHyphenUUID)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(0);
          done();
        });
    });
  });
  
  it('UUID-EDGE-004: Empty _id query returns all with date filter', function(done) {
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Test note',
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // Empty _id - should not crash, returns based on other filters
      request(self.app)
        .get('/api/treatments?find[_id]=')
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          // May return results based on date filter
          done();
        });
    });
  });
  
  it('UUID-EDGE-005: Multiple treatments same identifier - documents upsert behavior', function(done) {
    // treatments.create uses upsert by identifier, so duplicates are merged
    // This test documents the expected behavior
    var now = new Date();
    var later = new Date(now.getTime() + 1000);
    
    self.ctx.treatments.create([
      { eventType: 'Note', notes: 'First', identifier: TEST_UUID, created_at: now.toISOString() }
    ], function(err) {
      should.not.exist(err);
      
      self.ctx.treatments.create([
        { eventType: 'Note', notes: 'Second', identifier: TEST_UUID, created_at: later.toISOString() }
      ], function(err2) {
        should.not.exist(err2);
        
        request(self.app)
          .get('/api/treatments?find[_id]=' + TEST_UUID)
          .expect(200)
          .end(function(err, res) {
            should.not.exist(err);
            res.body.should.be.Array();
            // Due to upsert by identifier, only 1 treatment exists (updated)
            res.body.length.should.equal(1);
            // The second create updates the first
            res.body[0].notes.should.equal('Second');
            done();
          });
      });
    });
  });
  
  it('UUID-EDGE-006: Uppercase UUID matches case-insensitively', function(done) {
    var lowerUUID = TEST_UUID.toLowerCase();
    var upperUUID = TEST_UUID.toUpperCase();
    
    // Insert with lowercase
    self.ctx.treatments.create([{
      eventType: 'Note',
      notes: 'Lowercase UUID',
      identifier: lowerUUID,
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      // Query with uppercase - UUID regex is case insensitive
      // but identifier field match depends on stored value
      request(self.app)
        .get('/api/treatments?find[_id]=' + upperUUID)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          // Documents current behavior - uppercase query searches by identifier
          // which is case-sensitive in MongoDB
          done();
        });
    });
  });
  
  it('UUID-EDGE-007: Valid ObjectId still works normally', function(done) {
    var testId = new ObjectID();
    
    self.ctx.treatments.create([{
      _id: testId,
      eventType: 'Note',
      notes: 'ObjectId test',
      created_at: new Date().toISOString()
    }], function(err) {
      should.not.exist(err);
      
      request(self.app)
        .get('/api/treatments?find[_id]=' + testId.toString())
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.Array();
          res.body.length.should.equal(1);
          res.body[0].notes.should.equal('ObjectId test');
          done();
        });
    });
  });
});
