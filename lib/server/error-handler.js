'use strict';

const http = require('http');

// The last error handler in the express chain.
//
// With NODE_ENV=development this is express's errorhandler, which shows the
// error's message and full stack trace to the client. Anywhere else,
// including when NODE_ENV is unset, the client gets the status code and a
// short message only: the error's own message for a 4xx error that marks
// itself safe to show (err.expose, as body-parser and http-errors set it), or
// the standard reason phrase. The full error is logged on the server.

function statusOf (err, res) {
  const status = err && (err.status || err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }
  if (res.statusCode >= 400 && res.statusCode < 600) {
    return res.statusCode;
  }
  return 500;
}

function messageFor (err, status) {
  const reason = http.STATUS_CODES[status] || 'Error';
  if (status < 500 && err && err.expose === true && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return reason;
}

function escapeHtml (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function productionErrorHandler (options) {
  const opts = options || {};
  const log = opts.log === undefined ? process.env.NODE_ENV !== 'test' : opts.log;
  const logger = typeof log === 'function' ? log : function logError (err, req) {
    console.error('Unhandled error on', req.method, req.originalUrl || req.url, err);
  };

  return function errorHandler (err, req, res, next) {
    if (log) {
      logger(err, req);
    }

    // Express's own final handler closes the connection when a response has
    // already started.
    if (res.headersSent) {
      return next(err);
    }

    const status = statusOf(err, res);
    const message = messageFor(err, status);

    res.statusCode = status;
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const type = req.accepts(['html', 'json', 'text']);
    if (type === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { message: message, status: status } }));
    } else if (type === 'html') {
      const safe = escapeHtml(message);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + status + ' ' + safe +
        '</title></head><body><h1>' + status + '</h1><p>' + safe + '</p></body></html>\n');
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(status + ' ' + message + '\n');
    }
  };
}

function finalErrorHandler (options) {
  if (process.env.NODE_ENV === 'development') {
    return require('errorhandler')();
  }
  return productionErrorHandler(options);
}

module.exports = finalErrorHandler;
module.exports.productionErrorHandler = productionErrorHandler;
