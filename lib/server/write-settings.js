'use strict';

// The WRITE_* settings: how the write step (lib/storage/write-intent.js) treats
// a write, read once at boot (lib/server/env.js) into `env.write`. Each is a
// mode, its default first.
//
// - WRITE_VALIDATION=off|log|reject: the domain rules
//   (lib/server/write-validation.js). Parsed as it always was: any other value
//   is `off`. Also kept as `env.writeValidation`, which the write paths read.
// - WRITE_IDENTIFIER=lenient|strict (ID-VALIDATE, ID-Q6): an `identifier` that
//   is not a string of 1 to 256 characters, or is a placeholder, is treated as
//   absent under `lenient` (not matched on, not stored, logged as a warning)
//   and refused under `strict`. Any other value refuses to start.

var writeValidation = require('./write-validation');

var IDENTIFIER_MODES = ['lenient', 'strict'];

function parseIdentifierMode (value) {
  if (value === undefined || value === null || value === '') return { mode: 'lenient' };
  var mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (IDENTIFIER_MODES.indexOf(mode) === -1) {
    return { mode: 'lenient', error: 'WRITE_IDENTIFIER must be one of ' + IDENTIFIER_MODES.join(', ')
      + '; got ' + JSON.stringify(String(value)) };
  }
  return { mode: mode };
}

/**
 * @param {function(string, *): *} read the env reader (readENV)
 * @returns {{ write: { validation: string, identifier: string }, errors: string[] }}
 */
function parse (read) {
  var identifier = parseIdentifierMode(read('WRITE_IDENTIFIER', 'lenient'));
  return {
    write: Object.freeze({
      validation: writeValidation.parseMode(read('WRITE_VALIDATION', 'off'))
      , identifier: identifier.mode
    })
    , errors: identifier.error ? [identifier.error] : []
  };
}

// The WRITE_IDENTIFIER mode of a server env; `lenient` when none was parsed
// (a test env, an in-process caller without one).
function identifierMode (env) {
  var mode = env && env.write && env.write.identifier;
  return IDENTIFIER_MODES.indexOf(mode) > -1 ? mode : 'lenient';
}

module.exports = { parse: parse, parseIdentifierMode: parseIdentifierMode, identifierMode: identifierMode
  , IDENTIFIER_MODES: IDENTIFIER_MODES };
