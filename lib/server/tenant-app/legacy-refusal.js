'use strict';

// Preserve the shipping legacy API envelope without exposing provider details.
module.exports = res => res.status(401).json({
  status: 401, message: 'Unauthorized', description: 'Invalid/Missing'
});
