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
//   and refused under `strict`. Unset (or empty) is its own mode, `default`
//   (compat card A, option (i), maintainer 2026-10-31): API v3 refuses what
//   15.0.9's API v3 refused, a whitespace-only or numeric identifier, and
//   treats every other invalid one as absent; the other paths are lenient
//   (lib/storage/write-intent.js IDENTIFIER_UNSET_REFUSES). Any other value
//   refuses to start.
// - WRITE_DELETED_EDIT=ignore|refuse (ID-Q3): an edit of a soft-deleted record
//   over API v1 (PUT), the socket (dbUpdate, dbUpdateUnset) or an in-process
//   save is not applied, and the record stays deleted. `ignore` answers it as
//   done (2xx); `refuse` answers 410 (the socket: its per-item `refused` slot).
//   API v3 PUT and PATCH answer 410 under either. Any other value refuses to
//   start.
// - WRITE_RESEND=replace|merge|acknowledge|refuse (ID-RESEND-SWITCH,
//   compatibility C, maintainer 2026-10-31): what a re-send matched to a
//   stored record by an identity (identifier, a client id, _id) does, on every
//   path. `replace` (16.0.0, compatibility B) writes the re-send in place of
//   the stored record; `merge` merges it (RFC 7386), as before compatibility
//   B; `acknowledge` writes nothing and answers with the stored record;
//   `refuse` writes nothing and refuses it (409). Edits are not re-sends: API
//   v3 PATCH and the socket's dbUpdate / dbUpdateUnset merge under every mode,
//   and API v1 / in-process entries matched by sysTime + type merge as on
//   15.0.9. Any other value refuses to start.
// - WRITE_DELETED_RESEND=stay|revive (compatibility C): a re-send matched by
//   an identity to a soft-deleted record. `stay` (16.0.0, ID-Q4) leaves it
//   deleted and acknowledges the re-send; `revive` restores 15.0.9's re-send
//   behaviour. Any other value refuses to start.

var writeValidation = require('./write-validation');

var IDENTIFIER_MODES = ['lenient', 'strict'];
// The mode WRITE_IDENTIFIER unset selects; not a value it can be set to.
var IDENTIFIER_UNSET = 'default';
var DELETED_EDIT_MODES = ['ignore', 'refuse'];
var RESEND_MODES = ['replace', 'merge', 'acknowledge', 'refuse'];
var DELETED_RESEND_MODES = ['stay', 'revive'];

// One mode of a WRITE_* setting whose unknown values refuse to start: unset or
// empty is the first (the default); case and surrounding space aside.
function parseModeOf (name, modes, value) {
  if (value === undefined || value === null || value === '') return { mode: modes[0] };
  var mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (modes.indexOf(mode) === -1) {
    return { mode: modes[0], error: name + ' must be one of ' + modes.join(', ')
      + '; got ' + JSON.stringify(String(value)) };
  }
  return { mode: mode };
}

function parseResendMode (value) { return parseModeOf('WRITE_RESEND', RESEND_MODES, value); }
function parseDeletedResendMode (value) { return parseModeOf('WRITE_DELETED_RESEND', DELETED_RESEND_MODES, value); }

function parseIdentifierMode (value) {
  if (value === undefined || value === null || value === '') return { mode: IDENTIFIER_UNSET };
  var mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (IDENTIFIER_MODES.indexOf(mode) === -1) {
    return { mode: 'lenient', error: 'WRITE_IDENTIFIER must be one of ' + IDENTIFIER_MODES.join(', ')
      + '; got ' + JSON.stringify(String(value)) };
  }
  return { mode: mode };
}

function parseDeletedEditMode (value) {
  if (value === undefined || value === null || value === '') return { mode: 'ignore' };
  var mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (DELETED_EDIT_MODES.indexOf(mode) === -1) {
    return { mode: 'ignore', error: 'WRITE_DELETED_EDIT must be one of ' + DELETED_EDIT_MODES.join(', ')
      + '; got ' + JSON.stringify(String(value)) };
  }
  return { mode: mode };
}

/**
 * @param {function(string, *): *} read the env reader (readENV)
 * @returns {{ write: { validation: string, identifier: string, deletedEdit: string, resend: string,
 *   deletedResend: string }, errors: string[] }}
 */
function parse (read) {
  var identifier = parseIdentifierMode(read('WRITE_IDENTIFIER'));
  var deletedEdit = parseDeletedEditMode(read('WRITE_DELETED_EDIT', 'ignore'));
  var resend = parseResendMode(read('WRITE_RESEND', RESEND_MODES[0]));
  var deletedResend = parseDeletedResendMode(read('WRITE_DELETED_RESEND', DELETED_RESEND_MODES[0]));
  return {
    write: Object.freeze({
      validation: writeValidation.parseMode(read('WRITE_VALIDATION', 'off'))
      , identifier: identifier.mode
      , deletedEdit: deletedEdit.mode
      , resend: resend.mode
      , deletedResend: deletedResend.mode
    })
    , errors: [identifier.error, deletedEdit.error, resend.error, deletedResend.error].filter(Boolean)
  };
}

// The WRITE_IDENTIFIER mode of a server env: `lenient`, `strict`, or
// `default` when it was unset, and when none was parsed (a test env, an
// in-process caller without one), since that is the setting left unset.
function identifierMode (env) {
  var mode = env && env.write && env.write.identifier;
  return IDENTIFIER_MODES.indexOf(mode) > -1 ? mode : IDENTIFIER_UNSET;
}

// The WRITE_DELETED_EDIT mode of a server env; `ignore` when none was parsed.
function deletedEditMode (env) {
  var mode = env && env.write && env.write.deletedEdit;
  return DELETED_EDIT_MODES.indexOf(mode) > -1 ? mode : 'ignore';
}

// The WRITE_RESEND mode of a server env; `replace` when none was parsed.
function resendMode (env) {
  var mode = env && env.write && env.write.resend;
  return RESEND_MODES.indexOf(mode) > -1 ? mode : RESEND_MODES[0];
}

// The WRITE_RESEND mode for one client's write: the seam per-client D20
// quirks (and, under multitenancy, D22 policy rows) will select through.
// `client` is the writing client's registration, when the path knows one.
// Today every client gets the site setting.
// eslint-disable-next-line no-unused-vars
function resendModeFor (env, client) {
  return resendMode(env);
}

// The WRITE_DELETED_RESEND mode of a server env; `stay` when none was parsed.
function deletedResendMode (env) {
  var mode = env && env.write && env.write.deletedResend;
  return DELETED_RESEND_MODES.indexOf(mode) > -1 ? mode : DELETED_RESEND_MODES[0];
}

module.exports = { parse: parse, parseIdentifierMode: parseIdentifierMode, identifierMode: identifierMode
  , IDENTIFIER_MODES: IDENTIFIER_MODES, IDENTIFIER_UNSET: IDENTIFIER_UNSET, parseDeletedEditMode: parseDeletedEditMode, deletedEditMode: deletedEditMode
  , DELETED_EDIT_MODES: DELETED_EDIT_MODES
  , RESEND_MODES: RESEND_MODES, parseResendMode: parseResendMode, resendMode: resendMode, resendModeFor: resendModeFor
  , DELETED_RESEND_MODES: DELETED_RESEND_MODES, parseDeletedResendMode: parseDeletedResendMode
  , deletedResendMode: deletedResendMode };
