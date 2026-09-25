'use strict';

function deepMerge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();

  if (source === undefined) return target;

  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(function (key) {
      if (isUnsafeKey(key)) return;

      const sourceValue = source[key];
      if (isObject(sourceValue)) {
        const hasOwnTargetValue = Object.prototype.hasOwnProperty.call(target, key);
        let targetValue = hasOwnTargetValue ? target[key] : undefined;

        if (!hasOwnTargetValue || !targetValue) {
          targetValue = {};
          setOwnProperty(target, key, targetValue);
        }
        deepMerge(targetValue, sourceValue);
      } else {
        setOwnProperty(target, key, sourceValue);
      }
    });
  }
  return deepMerge(target, ...sources);
}

function isObject(item) {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
}

function isUnsafeKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function setOwnProperty(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = value;
    return;
  }

  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value: value,
    writable: true
  });
}

module.exports = deepMerge;
