'use strict';

const net = require('node:net');
const SUFFIXES = ['minimed.eu', 'minimed.com', 'auth0.com', 'arkoselabs.com', 'funcaptcha.com', 'hcaptcha.com'];
const EXACT = ['carelink-content.medtronic.com', 'www.google.com', 'www.gstatic.com', 'www.recaptcha.net',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'challenges.cloudflare.com'];
function allowedHost(host) {
  return typeof host === 'string' && !net.isIP(host) &&
    (EXACT.includes(host) || SUFFIXES.some(suffix => host === suffix || host.endsWith('.' + suffix)));
}
function allowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowedHost(url.hostname);
  } catch (_) { return false; }
}
function input(value, width, height) {
  if (!value || typeof value !== 'object') throw new Error('invalid_input');
  if (value.type === 'text' && typeof value.text === 'string' && value.text.length <= 2048) return { type: 'text', text: value.text };
  const keys = ['Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'];
  if (value.type === 'key' && keys.includes(value.key)) return { type: 'key', key: value.key, shift: value.shift === true };
  if (['click', 'scroll', 'pointer'].includes(value.type) && Number.isFinite(value.x) && Number.isFinite(value.y) &&
      value.x >= 0 && value.y >= 0 && value.x < width && value.y < height) {
    if (value.type === 'pointer' && !['down', 'move', 'up'].includes(value.phase)) throw new Error('invalid_input');
    return { type: value.type, x: Math.round(value.x), y: Math.round(value.y),
      phase: value.type === 'pointer' ? value.phase : undefined,
      delta: Math.max(-1000, Math.min(1000, Number(value.delta) || 0)) };
  }
  throw new Error('invalid_input');
}
module.exports = { allowedHost, allowedUrl, input };
