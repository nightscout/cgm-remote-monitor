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

describe('UUID_HANDLING=false (default)', function() {
  var self = this;
  this.timeout(10000);
  
  before(function(done) {
    // Ensure UUID_HANDLING is OFF
    delete process.env.UUID_HANDLING;
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
    var ObjectID = require('mongodb').ObjectId;
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
});

// ============================================
