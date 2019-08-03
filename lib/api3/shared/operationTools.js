'use strict';


function sendJSONStatus (res, status, title, description, warning) {

  const json = {
    status: status,
    message: title,
    description: description
  };

  // Add optional warning message.
  if (warning) { json.warning = warning; }

  res.status(status).json(json);

  return title;
}


module.exports = {
  sendJSONStatus
}