'use strict';

require('should');

const mongoStorage = require('../lib/storage/mongo-storage');

describe('MongoDB Connection Pool Configuration', function() {

  describe('Default Pool Size', function() {

    it('should have DEFAULT_POOL_SIZE set to 5', function() {
      mongoStorage.DEFAULT_POOL_SIZE.should.equal(5);
    });

    it('should have LEGACY_POOL_SIZE set to 100 for backward compatibility', function() {
      mongoStorage.LEGACY_POOL_SIZE.should.equal(100);
    });

  });

  describe('getPoolOptions', function() {

    it('should return default pool size of 5 when no env vars set', function() {
      const env = {};
      const options = mongoStorage.getPoolOptions(env);
      
      options.maxPoolSize.should.equal(5);
      options.minPoolSize.should.equal(0);
      options.maxIdleTimeMS.should.equal(30000);
    });

    it('should allow MONGO_POOL_SIZE to override default', function() {
      const env = { mongo_pool_size: '20' };
      const options = mongoStorage.getPoolOptions(env);
      
      options.maxPoolSize.should.equal(20);
    });

    it('should allow restoring legacy pool size of 100 via MONGO_POOL_SIZE', function() {
      const env = { mongo_pool_size: '100' };
      const options = mongoStorage.getPoolOptions(env);
      
      options.maxPoolSize.should.equal(100);
    });

    it('should allow MONGO_MIN_POOL_SIZE to set minimum connections', function() {
      const env = { mongo_min_pool_size: '2' };
      const options = mongoStorage.getPoolOptions(env);
      
      options.minPoolSize.should.equal(2);
    });

    it('should allow MONGO_MAX_IDLE_TIME_MS to control idle timeout', function() {
      const env = { mongo_max_idle_time_ms: '60000' };
      const options = mongoStorage.getPoolOptions(env);
      
      options.maxIdleTimeMS.should.equal(60000);
    });

    it('should handle all pool options together', function() {
      const env = {
        mongo_pool_size: '50',
        mongo_min_pool_size: '5',
        mongo_max_idle_time_ms: '120000'
      };
      const options = mongoStorage.getPoolOptions(env);
      
      options.maxPoolSize.should.equal(50);
      options.minPoolSize.should.equal(5);
      options.maxIdleTimeMS.should.equal(120000);
    });

  });

  describe('Pool Size Rationale', function() {

    it('default should be much smaller than MongoDB driver default of 100', function() {
      mongoStorage.DEFAULT_POOL_SIZE.should.be.lessThan(mongoStorage.LEGACY_POOL_SIZE);
      mongoStorage.DEFAULT_POOL_SIZE.should.be.lessThan(20);
    });

  });

});
