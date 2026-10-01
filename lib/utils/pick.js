/**
 * Helper function to pick specific properties from an object
 * @param {Object} obj - Source object
 * @param {string[]} keys - Array of keys to pick
 * @returns {Object} - New object with only the specified keys
 */
function pick(obj, keys) {
  // Return empty object if obj is null or undefined
  if (obj == null) {
    return {};
  }

  return keys.reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
    return result;
  }, {});
}

module.exports = pick;
