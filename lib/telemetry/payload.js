'use strict';

const allowlists = require('./allowlists');
const id = require('./id');

function releaseFamily (version) {
  if (!version || typeof version !== 'string') {
    return '0.x';
  }
  return version.split('.')[0] + '.x';
}

function deploymentFamily () {
  if (process.env.DYNO || process.env.HEROKU_APP_NAME) {
    return 'heroku';
  }
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME) {
    return 'railway';
  }
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    return 'render';
  }
  if (process.env.FLY_APP_NAME) {
    return 'fly';
  }
  if (process.env.WEBSITE_SITE_NAME) {
    return 'azure';
  }
  if (process.env.CONTAINER || process.env.container) {
    return 'docker';
  }
  return 'unknown';
}

function databaseFamily (env) {
  var uri = env && env.storageURI || '';
  if (/mongodb\.net/i.test(uri)) {
    return 'mongodb-atlas';
  }
  if (/^mongodb(\+srv)?:\/\//i.test(uri)) {
    return 'mongodb-compatible';
  }
  return 'unknown';
}

function build (env, ctx, options) {
  options = options || {};
  var now = options.now || new Date();
  var secret = options.installationSecret || options.secret;
  var counters = options.counters || { used: {}, health: {} };
  var health = counters.health || {};
  var settings = env && env.settings || {};

  var payload = {
    schema: 1,
    product: 'cgm-remote-monitor',
    release: releaseFamily(env && env.version),
    reporting_period: now.toISOString().slice(0, 10),
    installation_id: id.monthlyInstallationId(secret, now),
    runtime: {
      node_major: Number(process.versions.node.split('.')[0]),
      deployment_family: deploymentFamily()
    },
    features: {
      enabled: allowlists.filterFeatures(settings.enable || []),
      used: filterCounters(counters.used || {})
    },
    health: {
      startup: options.startup || startupStatus(ctx),
      uptime_bucket: options.uptimeBucket || 'unknown',
      http_2xx: health.http_2xx || 0,
      http_4xx: health.http_4xx || 0,
      http_5xx: health.http_5xx || 0
    }
  };

  if (process.versions.npm) {
    payload.runtime.npm_major = Number(process.versions.npm.split('.')[0]);
  }
  var dbFamily = databaseFamily(env);
  if (dbFamily !== 'unknown') {
    payload.runtime.database_family = dbFamily;
  }
  if (health.http_3xx) {
    payload.health.http_3xx = health.http_3xx;
  }
  if (health.websocket_connections) {
    payload.health.websocket_connections = health.websocket_connections;
  }
  return payload;
}

function startupStatus (ctx) {
  if (ctx && ctx.bootErrors && ctx.bootErrors.length > 0) {
    return 'config-error';
  }
  return 'success';
}

function filterCounters (used) {
  var filtered = {};
  Object.keys(used).forEach(function eachCounter (name) {
    if (allowlists.isAllowedCounter(name)) {
      filtered[name] = used[name];
    }
  });
  return filtered;
}

module.exports = {
  build,
  databaseFamily,
  deploymentFamily,
  releaseFamily
};
