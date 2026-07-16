'use strict';

function classify (req) {
  var path = (req.originalUrl || req.url || '').split('?')[0];
  var method = (req.method || 'GET').toUpperCase();
  var write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  if (path === '/report' || path.startsWith('/report.')) {
    return 'reports.opened';
  }

  if (path.startsWith('/api/v1/status')) {
    return 'api.v1.status.read';
  }
  if (path.startsWith('/api/v1/entries') || path.startsWith('/api/v1/echo') || path.startsWith('/api/v1/times') || path.startsWith('/api/v1/slice') || path.startsWith('/api/v1/count')) {
    return write ? 'api.v1.entries.write' : 'api.v1.entries.read';
  }
  if (path.startsWith('/api/v1/profile')) {
    return write ? null : 'api.v1.profile.read';
  }
  if (path.startsWith('/api/v1/devicestatus')) {
    return write ? 'api.v1.devicestatus.write' : 'api.v1.devicestatus.read';
  }

  if (path.startsWith('/api/v2/properties')) {
    return 'api.v2.properties.read';
  }

  if (path.startsWith('/api/v3/version')) {
    return 'api.v3.version.read';
  }
  if (path.startsWith('/api/v3/status')) {
    return 'api.v3.status.read';
  }
  if (path.startsWith('/api/v3/lastModified')) {
    return 'api.v3.last-modified.read';
  }
  if (path.startsWith('/api/v3/entries')) {
    return write ? 'api.v3.entries.write' : 'api.v3.entries.read';
  }

  return null;
}

function middleware (telemetry) {
  return function telemetryRouteCounters (req, res, next) {
    var counter = classify(req);

    res.on('finish', function onFinish () {
      telemetry.counters.recordStatus(res.statusCode);
      if (counter) {
        telemetry.counters.increment(counter);
      }
    });

    next();
  };
}

module.exports = {
  classify,
  middleware
};
