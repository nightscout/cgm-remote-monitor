'use strict';

const https = require('node:https');
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10000;

function failure(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

// Nightscout needs only messages and receipt cancellation, not a general SDK.
// Keep the origin fixed and never retry a POST whose delivery is uncertain.
class PushoverClient {
  constructor({token}) {
    this.token = token;
  }

  send(message, callback) {
    this.post('/1/messages.json', message, callback);
  }

  cancel(receipt, callback) {
    callback = typeof callback === 'function' ? callback : () => {};
    if (typeof receipt !== 'string' || !receipt) {
      queueMicrotask(() => callback(failure('EPUSHOVER_INPUT', 'Invalid Pushover receipt')));
      return;
    }
    let encoded;
    try { encoded = encodeURIComponent(receipt); } catch {
      queueMicrotask(() => callback(failure('EPUSHOVER_INPUT', 'Invalid Pushover receipt')));
      return;
    }
    this.post('/1/receipts/' + encoded + '/cancel.json', {}, (error, text, response) => callback(error, response));
  }

  post(path, fields, callback) {
    callback = typeof callback === 'function' ? callback : () => {};
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries({...fields, token: this.token})) {
      if (value !== undefined && value !== null) form.set(key, String(value));
    }
    const body = form.toString();
    let request, timer, finished = false;
    function finish(error, text, response) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback(error, text, response);
    }
    function abort(error) {
      // Destroy before calling application code; an error event may follow.
      if (request) request.destroy();
      finish(error);
    }
    try {
      request = https.request({hostname: 'api.pushover.net', port: 443, method: 'POST', path,
        rejectUnauthorized: true,
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body)}
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            abort(failure('EPUSHOVER_SIZE', 'Pushover response exceeded its size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => abort(failure('EPUSHOVER_TRANSPORT', 'Pushover response failed')));
        response.on('aborted', () => abort(failure('EPUSHOVER_TRANSPORT', 'Pushover response was interrupted')));
        response.on('end', () => {
          if (finished) return;
          const status = response.statusCode;
          if (status < 200 || status >= 300) {
            finish(failure('EPUSHOVER_HTTP', 'Pushover returned HTTP ' + status, status));
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let result;
          try { result = JSON.parse(text); } catch {
            finish(failure('EPUSHOVER_JSON', 'Pushover returned invalid JSON'));
            return;
          }
          if (!result || result.status !== 1) {
            finish(failure('EPUSHOVER_API', 'Pushover rejected the request'));
            return;
          }
          // Preserve the JSON-text contract consumed by pushnotify.
          finish(null, text, response);
        });
      });
      request.on('error', () => finish(failure('EPUSHOVER_TRANSPORT', 'Pushover request failed')));
      timer = setTimeout(() => abort(failure('EPUSHOVER_TIMEOUT', 'Pushover request timed out')), REQUEST_TIMEOUT_MS);
      request.end(body);
    } catch {
      if (request) request.destroy();
      queueMicrotask(() => finish(failure('EPUSHOVER_TRANSPORT', 'Pushover request failed')));
    }
  }
}

module.exports = PushoverClient;
