'use strict';

// The colour of the log prefixes Nightscout writes to stdout.
//
// The prefixes mark which part of the server is talking (WS:, STORAGE SOCKET:,
// ALARM SOCKET:, DEDUPE:). They are for a person reading a terminal. Written
// to a pipe - a log file, `docker logs`, syslog - the escape codes are only
// noise in front of every line, so the text is written plain there.
//
// NO_COLOR (https://no-color.org) and NODE_DISABLE_COLORS turn the colour off
// as well, and FORCE_COLOR turns it on, as Node does for its own output. See
// https://nodejs.org/api/tty.html#writestreamgetcolordepthenv

const CODES = Object.freeze({
  green: '\x1B[32m'
  , magenta: '\x1B[35m'
  , reset: '\x1B[0m'
});

// FORCE_COLOR, when it says anything: true to colour, false to leave it off,
// null to let the other rules decide.
function forced (environment) {
  const value = environment.FORCE_COLOR;
  if (value === undefined || value === null || value === '') return null;
  return value !== '0' && value !== 'false';
}

// NO_COLOR and NODE_DISABLE_COLORS are switches: set to anything, they turn
// the colour off (NO_COLOR: anything but empty).
function disabled (environment) {
  const noColor = environment.NO_COLOR;
  if (noColor !== undefined && noColor !== null && noColor !== '') return true;
  const nodeDisable = environment.NODE_DISABLE_COLORS;
  if (nodeDisable !== undefined && nodeDisable !== null && nodeDisable !== ''
    && nodeDisable !== '0' && nodeDisable !== 'false') return true;
  return false;
}

// Whether `stream` (stdout by default) can show colour under `environment`
// (process.env by default).
function colorsEnabled (stream, environment) {
  const target = stream || process.stdout;
  const variables = environment || process.env;

  const force = forced(variables);
  if (force !== null) return force;
  if (disabled(variables)) return false;
  if (!target || target.isTTY !== true) return false;
  if (typeof target.getColorDepth !== 'function') return true;
  try {
    return target.getColorDepth() > 1;
  } catch {
    // A stream that cannot say (a closed or redirected one) is not a
    // terminal we can colour.
    return false;
  }
}

// A log prefix such as 'WS: ' in the colour named by `color` ('green' or
// 'magenta'), or the same text without escape codes where colour is off.
// `options.stream` and `options.env` exist for tests.
function logPrefix (label, color, options) {
  const settings = options || {};
  if (!colorsEnabled(settings.stream, settings.env)) return label;
  const code = CODES[color];
  if (!code) return label;
  return code + label + CODES.reset;
}

module.exports = {
  colorsEnabled: colorsEnabled
  , logPrefix: logPrefix
};
