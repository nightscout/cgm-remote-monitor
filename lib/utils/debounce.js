'use strict';

/**
 * Creates a debounced function. Supports the lodash debounce options used by
 * the boot event data loader: leading, trailing, and maxWait.
 *
 * @param {Function} func The function to debounce
 * @param {number} wait The number of milliseconds to delay
 * @param {Object} options Debounce options
 * @returns {Function} The debounced function
 */
function debounce(func, wait, options) {
  options = options || {};
  const leading = options.leading === true;
  const trailing = options.trailing !== false;
  const maxWait = options.maxWait;

  let timeout;
  let maxTimeout;
  let lastArgs;
  let lastThis;
  let callsSinceInvoke = 0;

  function invoke() {
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    callsSinceInvoke = 0;
    func.apply(thisArg, args);
  }

  function clearMaxTimeout() {
    if (maxTimeout) {
      clearTimeout(maxTimeout);
      maxTimeout = undefined;
    }
  }

  function trailingEdge() {
    timeout = undefined;

    if (trailing && callsSinceInvoke > 0) {
      invoke();
    }

    clearMaxTimeout();
    callsSinceInvoke = 0;
  }

  function maxEdge() {
    maxTimeout = undefined;

    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    if (trailing && callsSinceInvoke > 0) {
      invoke();
    }
  }

  return function executedFunction(...args) {
    const shouldInvokeLeading = leading && !timeout && !maxTimeout;

    lastArgs = args;
    lastThis = this;

    if (shouldInvokeLeading) {
      invoke();
    } else {
      callsSinceInvoke++;
    }

    clearTimeout(timeout);
    timeout = setTimeout(trailingEdge, wait);

    if (maxWait && !maxTimeout) {
      maxTimeout = setTimeout(maxEdge, maxWait);
    }
  };
}

module.exports = debounce;
