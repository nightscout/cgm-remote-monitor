'use strict';

// Public errors are deliberately independent of provider response bodies/URLs.
class ConnectError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
module.exports = ConnectError;
