'use strict';

// ==================================================================
// NIGHTSCOUT PLUGIN: Webhook Notifier
// ==================================================================
// Sends an HTTP POST webhook to a local server whenever a NEW SGV
// (glucose) value is available in Nightscout.
//
// Configure via environment variables:
//   WEBHOOK_PROTOCOL  (default: http)
//   WEBHOOK_HOST      (default: localhost)
//   WEBHOOK_PORT      (default: 3000)
//   WEBHOOK_PATH      (default: /nightscout)
//
// Example:
//   WEBHOOK_PROTOCOL=https
//   WEBHOOK_HOST=192.168.10.5
//   WEBHOOK_PORT=33333
//   WEBHOOK_PATH=/nightscout
//
// Notes:
// - This is a server-side Nightscout plugin.
// - Uses sbx helper methods (lastSGVMgdl / lastSGVMills) for stability.
// - Deduplicates by timestamp so it triggers once per new SGV.
// - The SGV present at startup is skipped; only readings ingested after
//   the process starts will fire a webhook.
// - lastSentMills is updated only after a successful (2xx) response,
//   providing at-least-once delivery: a failed request will be retried
//   on the next checkNotifications cycle.
// ==================================================================

module.exports = function webhookPlugin() {
  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const WEBHOOK_PROTOCOL = process.env.WEBHOOK_PROTOCOL || 'http';
  const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'localhost';
  const WEBHOOK_PORT = process.env.WEBHOOK_PORT || '3000';
  const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/nightscout';
  const WEBHOOK_URL = `${WEBHOOK_PROTOCOL}://${WEBHOOK_HOST}:${WEBHOOK_PORT}${WEBHOOK_PATH}`;

  const WEBHOOK_TIMEOUT_MS = 5000;

  const http = require('http');
  const https = require('https');
  const url = require('url');

  // mills of the last SGV for which a webhook was successfully delivered.
  let lastSentMills = null;
  // mills of a request currently in flight; prevents duplicate concurrent sends.
  let pendingMills = null;
  // true after the first checkNotifications call; suppresses the startup SGV.
  let initialized = false;

  // ------------------------------------------------------------------
  // Send HTTP/HTTPS POST JSON webhook
  // Exposed on the returned object so tests can replace it.
  // ------------------------------------------------------------------
  function sendWebhook(payload, onSuccess, onFailure) {
    const parsed = url.parse(WEBHOOK_URL);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const body = JSON.stringify(payload);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      timeout: WEBHOOK_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = protocol.request(options, (res) => {
      // Drain response to avoid socket issues in some Node versions.
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          onSuccess();
        } else {
          console.warn('[Webhook] Non-2xx response from webhook endpoint:', res.statusCode);
          onFailure();
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Webhook] Webhook request failed:', err.message);
      onFailure();
    });

    req.on('timeout', () => {
      console.error('[Webhook] Webhook request timed out after', WEBHOOK_TIMEOUT_MS, 'ms');
      req.destroy();
      // onFailure will be called via the 'error' event that destroy() triggers.
    });

    req.write(body);
    req.end();
  }

  // ------------------------------------------------------------------
  // Nightscout lifecycle hook: called periodically
  // ------------------------------------------------------------------
  function checkNotifications(sbx) {
    if (!sbx) return;

    const mgdl = typeof sbx.lastSGVMgdl === 'function' ? sbx.lastSGVMgdl() : null;
    const mills = typeof sbx.lastSGVMills === 'function' ? sbx.lastSGVMills() : null;

    if (!mgdl || !mills) return;

    // On first call after startup, record the current SGV as already seen
    // so we do not fire a webhook for a reading that pre-dates this process.
    if (!initialized) {
      lastSentMills = mills;
      initialized = true;
      return;
    }

    // Skip if already successfully delivered or a request is in flight.
    if (mills === lastSentMills || mills === pendingMills) return;

    pendingMills = mills;

    const payload = {
      source: 'nightscout',
      mgdl,
      mills,
      iso: new Date(mills).toISOString()
    };

    // Use plugin.sendWebhook so tests can replace it.
    plugin.sendWebhook(
      payload,
      function onSuccess() {
        lastSentMills = mills;
        if (pendingMills === mills) pendingMills = null;
      },
      function onFailure() {
        // Clear pendingMills so the next cycle can retry.
        if (pendingMills === mills) pendingMills = null;
      }
    );
  }

  // ------------------------------------------------------------------
  // Plugin metadata
  // ------------------------------------------------------------------
  const plugin = {
    name: 'webhook',
    label: 'Webhook Notifier',
    pluginType: 'notification',

    // Called once when the plugin initializes.
    init: function () {
      console.log('[Webhook] Enabled. Sending webhooks to:', WEBHOOK_URL);
    },

    // Replaceable in tests.
    sendWebhook,

    // Called periodically by Nightscout.
    checkNotifications
  };

  return plugin;
};
