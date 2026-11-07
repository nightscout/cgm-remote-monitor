'use strict';

var UNIT_MSECS = {
  ns: 1 / 1e6,
  nanosecond: 1 / 1e6,
  us: 1 / 1e3,
  microsecond: 1 / 1e3,
  ms: 1,
  millisecond: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  wk: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  b: 365.25 / 12 * 24 * 60 * 60 * 1000,
  month: 365.25 / 12 * 24 * 60 * 60 * 1000,
  y: 365.25 * 24 * 60 * 60 * 1000,
  yr: 365.25 * 24 * 60 * 60 * 1000,
  year: 365.25 * 24 * 60 * 60 * 1000
};

function getUnitMsecs(unit) {
  if (!unit) return 1;

  var normalized = unit.toLowerCase();
  return UNIT_MSECS[normalized] || UNIT_MSECS[normalized.replace(/s$/, '')] || 1;
}

function isDigit(character) {
  return character >= '0' && character <= '9';
}

function isUnitCharacter(character) {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

function removeDigitGroupCommas(text) {
  var cleaned = '';

  for (var i = 0; i < text.length; i++) {
    if (text[i] === ',' && i > 0 && i < text.length - 1 && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
      continue;
    }
    cleaned += text[i];
  }

  return cleaned;
}

function readNumber(text, start) {
  var index = start;
  var hasDigit = false;

  if (text[index] === '-') index++;

  while (isDigit(text[index])) {
    hasDigit = true;
    index++;
  }

  if (text[index] === '.') {
    index++;
    while (isDigit(text[index])) {
      hasDigit = true;
      index++;
    }
  }

  if (!hasDigit) return null;

  if (text[index] === 'e' || text[index] === 'E') {
    var exponentStart = index;
    index++;
    if (text[index] === '-' || text[index] === '+') index++;

    var hasExponentDigit = false;
    while (isDigit(text[index])) {
      hasExponentDigit = true;
      index++;
    }

    if (!hasExponentDigit) index = exponentStart;
  }

  return {
    value: parseFloat(text.slice(start, index)),
    end: index
  };
}

function parseDurationMsecs(value) {
  if (value === null || value === undefined) return 0;

  var text = removeDigitGroupCommas(String(value));
  var result = 0;

  for (var i = 0; i < text.length; i++) {
    var parsed = readNumber(text, i);
    if (!parsed) continue;

    i = parsed.end;
    while (text[i] === ' ' || text[i] === '\t') i++;

    var unitStart = i;
    while (isUnitCharacter(text[i])) i++;

    result += parsed.value * getUnitMsecs(text.slice(unitStart, i));
    i--;
  }

  return result;
}

module.exports = parseDurationMsecs;
