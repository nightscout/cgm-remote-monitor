'use strict';

const { decodeHTML } = require('entities/decode');
const { escapeText } = require('entities/escape');

function asString (value) {
  return value === null || typeof value === 'undefined' ? '' : String(value);
}

/**
 * Convert persisted HTML serialization to the text a user should see.
 *
 * Use this only with a text-only DOM API such as jQuery.text(),
 * textContent, or option.text. Decoding one layer keeps values written by
 * the current server sanitizer readable without turning them into markup.
 */
function toTextContent (value) {
  return decodeHTML(asString(value));
}

/**
 * Encode untrusted data for interpolation into an HTML text-node context.
 *
 * The decode-then-encode sequence makes this safe and display-equivalent
 * for both legacy raw values and values serialized by sanitize-html.
 * Never use this helper for an HTML attribute, URL, script, or CSS context.
 */
function textAsHtml (value) {
  return escapeText(toTextContent(value));
}

module.exports = {
  asString,
  textAsHtml,
  toTextContent
};
