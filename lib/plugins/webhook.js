'use strict';

// ==================================================================
// NIGHTSCOUT PLUGIN: Webhook Notifier
// ==================================================================
// Sends an HTTP POST webhook to a local server whenever a NEW SGV
// (glucose) value is available in Nightscout.
//
// Configure via environment variables:
//   WEBHOOK_HOST  (default: localhost)
//   WEBHOOK_PORT  (default: 3000)
//   WEBHOOK_PATH  (default: /nightscout)
//
// Example:
//   WEBHOOK_HOST=192.168.10.5
//   WEBHOOK_PORT=33333
//   WEBHOOK_PATH=/nightscout
//
// Notes:
// - This is a server-side Nightscout plugin.
// - Uses sbx helper methods (lastSGVMgdl / lastSGVMills) for stability.
// - Deduplicates by timestamp so it triggers once per new SGV.
// ==================================================================

module.exports = function webhookPlugin() {
  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'localhost';
  const WEBHOOK_PORT = process.env.WEBHOOK_PORT || '3000';
  const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/nightscout';
  const WEBHOOK_URL = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}${WEBHOOK_PATH}`;

  const WEBHOOK_TIMEOUT_MS = 5000;

  const http = require('http');
  const https = require('https');
  const url = require('url');

  // Used to prevent sending duplicate webhooks for the same SGV.
  let lastSentMills = null;

  // ------------------------------------------------------------------
  // Send HTTP POST JSON webhook
  // ------------------------------------------------------------------
  function sendWebhook(payload) {
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
      res.on('end', () => {});

      // Keep logs minimal but useful for ops.
      if (res.statusCode !== 200) {
        console.warn('[Webhook] Non-200 response from webhook endpoint:', res.statusCode);
      }
    });

    req.on('error', (err) => {
      console.error('[Webhook] Webhook request failed:', err.message);
    });

    req.on('timeout', () => {
      console.error('[Webhook] Webhook request timed out after', WEBHOOK_TIMEOUT_MS, 'ms');
      req.destroy();
    });

    req.write(body);
    req.end();
  }

  // ------------------------------------------------------------------
  // Nightscout lifecycle hook: called periodically
  // ------------------------------------------------------------------
  function checkNotifications(sbx) {
    if (!sbx) return;

    // Stable, server-side accessors for SGV and timestamp (ms).
    const mgdl = typeof sbx.lastSGVMgdl === 'function' ? sbx.lastSGVMgdl() : null;
    const mills = typeof sbx.lastSGVMills === 'function' ? sbx.lastSGVMills() : null;

    // If we don't have a valid SGV yet, do nothing.
    if (!mgdl || !mills) return;

    // Deduplicate by timestamp (one webhook per new SGV).
    if (lastSentMills === mills) return;
    lastSentMills = mills;

    // Minimal payload; the iOS app can fetch details from Nightscout if needed.
    const payload = {
      source: 'nightscout',
      mgdl,
      mills,
      iso: new Date(mills).toISOString()
    };

    sendWebhook(payload);
  }

  // ------------------------------------------------------------------
  // Plugin metadata
  // ------------------------------------------------------------------
  return {
    name: 'webhook',
    label: 'Webhook Notifier',
    pluginType: 'notification',

    // Called once when plugin initializes
    init: function () {
      console.log('[Webhook] Enabled. Sending webhooks to:', WEBHOOK_URL);
    },

    // Called periodically by Nightscout
    checkNotifications
  };
};
