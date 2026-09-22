'use strict';

// Public errors are deliberately independent of provider response bodies/URLs.
class ConnectError extends Error {
  constructor(code, status = 400, diagnostic) {
    super(code);
    this.code = code;
    this.status = status;
    this.diagnostic = ConnectError.safeDiagnostic(diagnostic);
  }
  static safeDiagnostic(value) {
    if (!value || typeof value !== 'object') return undefined;
    const safe = {};
    if (['http_error', 'invalid_json', 'network_error', 'timeout', 'response_too_large', 'dns_error'].includes(value.reason)) safe.reason = value.reason;
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) safe.httpStatus = value.httpStatus;
    if (['discovery', 'login_configuration', 'token_exchange', 'token_refresh', 'account_details', 'account_profile', 'country_settings', 'patient_list', 'glucose_data'].includes(value.operation)) safe.operation = value.operation;
    return Object.keys(safe).length ? safe : undefined;
  }
}
module.exports = ConnectError;
