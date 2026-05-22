'use strict';

/**
 * Shared test helper utilities for the Nightscout test suite.
 * 
 * This module provides utilities for:
 * - Polling-based waits with warning timeouts (instead of arbitrary setTimeout)
 * - Detecting slow operations in tests
 * - Reducing flaky test issues caused by timing
 */

/**
 * Helper function to wait for a condition with warning timeout.
 * Instead of using arbitrary setTimeout delays, this function:
 * 1. Polls for a condition to be true
 * 2. Warns if the operation is taking longer than expected
 * 3. Fails hard only after a maximum timeout
 * 
 * This approach:
 * - Completes tests as fast as possible (polls immediately and frequently)
 * - Surfaces slow operations (logs warnings when operations take longer than expected)
 * - Has a hard timeout (fails cleanly if the expected state is never reached)
 * 
 * @param {Object} options
 * @param {Function} options.condition - Function that checks if expected state is reached, receives callback(err, result)
 * @param {Function} options.assertion - Function to run assertions on result
 * @param {Function} options.done - Mocha done callback
 * @param {number} [options.warningThreshold=200] - ms before warning is logged
 * @param {number} [options.pollInterval=50] - ms between polls
 * @param {number} [options.maxTimeout=5000] - ms before hard failure
 * @param {string} [options.operationName='Operation'] - Name for logging
 * 
 * @example
 * waitForConditionWithWarning({
 *   condition: function(cb) {
 *     ctx.treatments.list({}, cb);
 *   },
 *   assertion: function(list) {
 *     list.length.should.be.greaterThanOrEqual(3);
 *   },
 *   done: done,
 *   operationName: 'verify treatments created',
 *   warningThreshold: 200,  // Warn if taking >200ms
 *   maxTimeout: 5000        // Fail if >5s
 * });
 */
function waitForConditionWithWarning(options) {
  var startTime = Date.now();
  var warningIssued = false;
  var warningTimer = null;
  
  var warningThreshold = options.warningThreshold || 200;
  var pollInterval = options.pollInterval || 50;
  var maxTimeout = options.maxTimeout || 5000;
  var operationName = options.operationName || 'Operation';
  
  warningTimer = setTimeout(function() {
    warningIssued = true;
    console.warn('[SLOW TEST WARNING] ' + operationName + ' taking longer than ' + warningThreshold + 'ms');
  }, warningThreshold);
  
  function poll() {
    var elapsed = Date.now() - startTime;
    
    if (elapsed > maxTimeout) {
      clearTimeout(warningTimer);
      options.done(new Error(operationName + ' timed out after ' + maxTimeout + 'ms'));
      return;
    }
    
    options.condition(function(err, result) {
      if (err) {
        clearTimeout(warningTimer);
        options.done(err);
        return;
      }
      
      try {
        options.assertion(result);
        clearTimeout(warningTimer);
        
        if (warningIssued) {
          console.log('[SLOW TEST INFO] ' + operationName + ' completed after ' + elapsed + 'ms');
        }
        
        options.done();
      } catch (assertionError) {
        setTimeout(poll, pollInterval);
      }
    });
  }
  
  poll();
}

/**
 * Promise-based version of waitForConditionWithWarning.
 * Useful for async/await test patterns.
 * 
 * @param {Object} options
 * @param {Function} options.condition - Async function that returns the value to check
 * @param {Function} options.assertion - Function to run assertions on result (throws if fails)
 * @param {number} [options.warningThreshold=200] - ms before warning is logged
 * @param {number} [options.pollInterval=50] - ms between polls
 * @param {number} [options.maxTimeout=5000] - ms before hard failure
 * @param {string} [options.operationName='Operation'] - Name for logging
 * @returns {Promise} Resolves when condition is met, rejects on timeout
 * 
 * @example
 * await waitForConditionAsync({
 *   condition: async () => await fetchTreatments(),
 *   assertion: (list) => { if (list.length < 3) throw new Error('Not enough'); },
 *   operationName: 'wait for treatments',
 *   warningThreshold: 200,
 *   maxTimeout: 5000
 * });
 */
function waitForConditionAsync(options) {
  return new Promise((resolve, reject) => {
    var startTime = Date.now();
    var warningIssued = false;
    var warningTimer = null;
    
    var warningThreshold = options.warningThreshold || 200;
    var pollInterval = options.pollInterval || 50;
    var maxTimeout = options.maxTimeout || 5000;
    var operationName = options.operationName || 'Operation';
    
    warningTimer = setTimeout(function() {
      warningIssued = true;
      console.warn('[SLOW TEST WARNING] ' + operationName + ' taking longer than ' + warningThreshold + 'ms');
    }, warningThreshold);
    
    async function poll() {
      var elapsed = Date.now() - startTime;
      
      if (elapsed > maxTimeout) {
        clearTimeout(warningTimer);
        reject(new Error(operationName + ' timed out after ' + maxTimeout + 'ms'));
        return;
      }
      
      try {
        var result = await options.condition();
        options.assertion(result);
        clearTimeout(warningTimer);
        
        if (warningIssued) {
          console.log('[SLOW TEST INFO] ' + operationName + ' completed after ' + elapsed + 'ms');
        }
        
        resolve(result);
      } catch (assertionError) {
        setTimeout(poll, pollInterval);
      }
    }
    
    poll();
  });
}

/**
 * Wraps setTimeout usage with timing instrumentation.
 * Logs a warning if the delay is suspiciously long (potential flaky test source).
 * 
 * @param {Function} fn - Function to execute after delay
 * @param {number} delay - Delay in milliseconds
 * @param {string} [context=''] - Optional context for logging
 * @returns {number} Timer ID
 */
function instrumentedSetTimeout(fn, delay, context) {
  var SUSPICIOUS_DELAY_THRESHOLD = 100;
  
  if (delay >= SUSPICIOUS_DELAY_THRESHOLD) {
    console.warn('[TIMING WARNING] setTimeout with ' + delay + 'ms delay detected' + 
      (context ? ' in ' + context : '') + 
      '. Consider using waitForConditionWithWarning instead.');
  }
  
  return setTimeout(fn, delay);
}

/**
 * Creates a tracked delay that logs timing information.
 * Useful for debugging slow tests or understanding where time is spent.
 * 
 * @param {number} ms - Delay in milliseconds
 * @param {string} [reason='unknown'] - Reason for the delay
 * @returns {Promise} Resolves after delay
 */
function trackedDelay(ms, reason) {
  var startTime = Date.now();
  console.log('[DELAY START] Waiting ' + ms + 'ms for: ' + (reason || 'unknown'));
  
  return new Promise(resolve => {
    setTimeout(() => {
      var actual = Date.now() - startTime;
      if (Math.abs(actual - ms) > 20) {
        console.warn('[DELAY WARNING] Expected ' + ms + 'ms but actual was ' + actual + 'ms for: ' + (reason || 'unknown'));
      }
      console.log('[DELAY END] Completed wait of ' + actual + 'ms for: ' + (reason || 'unknown'));
      resolve();
    }, ms);
  });
}

/**
 * Monitors test execution time and warns if a test is taking too long.
 * Call at the start of a test and it returns a function to call at the end.
 * 
 * @param {string} testName - Name of the test
 * @param {number} [warningThreshold=1000] - ms before warning
 * @param {number} [errorThreshold=5000] - ms before error-level warning
 * @returns {Function} Call this at the end of the test
 */
function startTestTimer(testName, warningThreshold, errorThreshold) {
  var startTime = Date.now();
  warningThreshold = warningThreshold || 1000;
  errorThreshold = errorThreshold || 5000;
  
  return function endTimer() {
    var elapsed = Date.now() - startTime;
    
    if (elapsed > errorThreshold) {
      console.error('[SLOW TEST ERROR] "' + testName + '" took ' + elapsed + 'ms (threshold: ' + errorThreshold + 'ms)');
    } else if (elapsed > warningThreshold) {
      console.warn('[SLOW TEST WARNING] "' + testName + '" took ' + elapsed + 'ms (threshold: ' + warningThreshold + 'ms)');
    }
    
    return elapsed;
  };
}

/**
 * Detects setTimeout anti-patterns in test code.
 * This is a development-time helper to find potential flaky test sources.
 * 
 * @param {Object} options
 * @param {boolean} [options.warnOnLongDelays=true] - Warn on delays > 100ms
 * @param {boolean} [options.warnOnHardcodedDelays=false] - Warn on any hardcoded delay
 * @param {number} [options.longDelayThreshold=100] - What counts as a "long" delay
 */
function enableSetTimeoutWarnings(options) {
  options = options || {};
  var warnOnLongDelays = options.warnOnLongDelays !== false;
  var warnOnHardcodedDelays = options.warnOnHardcodedDelays || false;
  var longDelayThreshold = options.longDelayThreshold || 100;
  
  var originalSetTimeout = global.setTimeout;
  var callCount = 0;
  
  global.setTimeout = function(fn, delay) {
    callCount++;
    
    if (warnOnHardcodedDelays && typeof delay === 'number' && delay > 0) {
      console.warn('[SETTIMEOUT ANTI-PATTERN #' + callCount + '] Hardcoded delay of ' + delay + 'ms detected. Consider using polling patterns.');
    } else if (warnOnLongDelays && delay >= longDelayThreshold) {
      console.warn('[SETTIMEOUT ANTI-PATTERN #' + callCount + '] Long delay of ' + delay + 'ms detected. This may cause flaky tests.');
    }
    
    return originalSetTimeout.apply(global, arguments);
  };
  
  return function restore() {
    global.setTimeout = originalSetTimeout;
    return callCount;
  };
}

module.exports = {
  waitForConditionWithWarning: waitForConditionWithWarning,
  waitForConditionAsync: waitForConditionAsync,
  instrumentedSetTimeout: instrumentedSetTimeout,
  trackedDelay: trackedDelay,
  startTestTimer: startTestTimer,
  enableSetTimeoutWarnings: enableSetTimeoutWarnings
};
