'use strict';

// Craft a JSON friendly status (or error) message.
function sendJSONStatus(res, status, title, description, warning) {
  var json = {
    status: status,
    message: title,
    description: description
  };

  // Add optional warning message.
  if (warning) { json.warning = warning; }

  res.status(status).json(json);
}

function configure ( ) {
  function middleware (req, res, next) {
    res.sendJSONStatus = sendJSONStatus;
    next( );
  }
  return middleware;
}

module.exports = configure;
