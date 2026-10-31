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
// - WRITE_DELETED_EDIT=ignore|refuse (ID-Q3): an edit of a soft-deleted record
//   over API v1 (PUT), the socket (dbUpdate, dbUpdateUnset) or an in-process
//   save is not applied, and the record stays deleted. `ignore` answers it as
//   done (2xx); `refuse` answers 410 (the socket: its per-item `refused` slot).
//   API v3 PUT and PATCH answer 410 under either. Any other value refuses to
//   start.
// - WRITE_IDENTIFIER_INDEX=try|require|off|drop (ID-UNIQUE-INDEX, decided
//   2026-10-30; `drop` 2026-10-31): the partial unique index on `identifier`,
//   per collection (lib/storage/identifier-index.js). `try` builds it at boot
//   where no stored duplicates block it, and otherwise logs and shows the
//   counts and runs without it; `require` refuses to start without it; `off`
//   builds nothing and drops nothing (an index already there stays enforced,
//   and the log and the status page say so); `drop` removes it from each
//   collection at boot and then runs as `off`. Any other value refuses to
//   start.

var writeValidation = require('./write-validation');

var IDENTIFIER_MODES = ['lenient', 'strict'];
var DELETED_EDIT_MODES = ['ignore', 'refuse'];
var INDEX_MODES = ['try', 'require', 'off', 'drop'];

// A mode from a list, its first entry when unset; any other value is the
// first entry and an error naming the setting.
function parseMode (name, modes, value) {
  if (value === undefined || value === null || value === '') return { mode: modes[0] };
  var mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (modes.indexOf(mode) === -1) {
    return { mode: modes[0], error: name + ' must be one of ' + modes.join(', ')
      + '; got ' + JSON.stringify(String(value)) };
  }
  return { mode: mode };
}

function parseIdentifierMode (value) {
  return parseMode('WRITE_IDENTIFIER', IDENTIFIER_MODES, value);
}

function parseDeletedEditMode (value) {
  return parseMode('WRITE_DELETED_EDIT', DELETED_EDIT_MODES, value);
}

function parseIndexMode (value) {
  return parseMode('WRITE_IDENTIFIER_INDEX', INDEX_MODES, value);
}

/**
 * @param {function(string, *): *} read the env reader (readENV)
 * @returns {{ write: { validation: string, identifier: string, deletedEdit: string, index: string },
 *   errors: string[] }}
 */
function parse (read) {
  var identifier = parseIdentifierMode(read('WRITE_IDENTIFIER', 'lenient'));
  var deletedEdit = parseDeletedEditMode(read('WRITE_DELETED_EDIT', 'ignore'));
  var index = parseIndexMode(read('WRITE_IDENTIFIER_INDEX', 'try'));
  return {
    write: Object.freeze({
      validation: writeValidation.parseMode(read('WRITE_VALIDATION', 'off'))
      , identifier: identifier.mode
      , deletedEdit: deletedEdit.mode
      , index: index.mode
    })
    , errors: [identifier.error, deletedEdit.error, index.error].filter(Boolean)
  };
}

// The WRITE_IDENTIFIER mode of a server env; `lenient` when none was parsed
// (a test env, an in-process caller without one).
function identifierMode (env) {
  var mode = env && env.write && env.write.identifier;
  return IDENTIFIER_MODES.indexOf(mode) > -1 ? mode : 'lenient';
}

// The WRITE_DELETED_EDIT mode of a server env; `ignore` when none was parsed.
function deletedEditMode (env) {
  var mode = env && env.write && env.write.deletedEdit;
  return DELETED_EDIT_MODES.indexOf(mode) > -1 ? mode : 'ignore';
}

// The WRITE_IDENTIFIER_INDEX mode of a server env; `try` when none was parsed.
function indexMode (env) {
  var mode = env && env.write && env.write.index;
  return INDEX_MODES.indexOf(mode) > -1 ? mode : 'try';
}

module.exports = { parse: parse, parseIdentifierMode: parseIdentifierMode, identifierMode: identifierMode
  , IDENTIFIER_MODES: IDENTIFIER_MODES, parseDeletedEditMode: parseDeletedEditMode, deletedEditMode: deletedEditMode
  , DELETED_EDIT_MODES: DELETED_EDIT_MODES, parseIndexMode: parseIndexMode, indexMode: indexMode
  , INDEX_MODES: INDEX_MODES };
