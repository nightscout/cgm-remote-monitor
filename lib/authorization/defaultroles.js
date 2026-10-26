'use strict';

// AUTH_DEFAULT_ROLES holds a LIST of roles, not a single role. Roles are
// separated by commas, spaces or colons, and other settings append to the
// list: the deprecated TREATMENTS_AUTH=off adds ' careportal', so the
// shipped default 'readable' resolves to 'readable careportal'.
//
// Anything asking "does an unauthenticated visitor have this role?" has to
// read the list. Comparing the whole setting string to one role name gives
// the wrong answer as soon as a second role is present.

function parse (value) {
  return (value || '').split(/[, :]/);
}

// Appending to an empty setting leaves a leading separator, so the parsed
// list can contain empty strings. They never equal a real role name, so
// indexOf needs no special handling for them.
function has (value, role) {
  return parse(value).indexOf(role) > -1;
}

module.exports = {
  parse: parse
  , has: has
};
