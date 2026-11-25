'use strict';

// The operator's list of signed-in identities and the local roles each gets,
// plus the role for anyone else who signs in. Inline in OIDC_IDENTITIES or a
// CSV, TSV or JSON file named by OIDC_IDENTITIES_FILE; never both.
//
//   OIDC_IDENTITIES=sub:248289761001=careportal+readable,email:carer@example.test=readable
//   OIDC_FALLBACK_ROLES=readable
//
// An entry is keyed on the issuer (OIDC_ISSUER unless the entry names one) and
// either the provider's subject or an email address. An email entry matches
// only when that same issuer marks the address verified.
const path = require('node:path');
const { privateSource, refuse } = require('./private-setting');
const { normalEmail, MAX_PRINCIPALS } = require('./mongo');
const ROLE = /^[^\s+,;:]{1,128}$/;
const NAME = /^[A-Za-z0-9 ._-]{1,64}$/;
const FIELDS = ['issuer', 'subject', 'email', 'roles', 'name', 'management'];
const control = value => value.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function splitRoles (value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  return value.split(/[+\s]+/).filter(Boolean);
}

function entry (raw, issuer, where) {
  const bad = why => refuse('OIDC identity list ' + where + ': ' + why);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !FIELDS.includes(key))) bad('unknown field');
  const blank = value => value === undefined || value === null || value === '';
  if (blank(raw.subject) === blank(raw.email)) bad('give exactly one of subject or email');
  const selected = blank(raw.issuer) ? issuer : raw.issuer;
  if (typeof selected !== 'string' || !selected || selected.length > 2048 || control(selected)) bad('invalid issuer');
  const roles = splitRoles(raw.roles);
  if (!roles || !roles.length || roles.length > 32 || roles.some(role => typeof role !== 'string' || !ROLE.test(role))) bad('give one or more role names');
  if (!blank(raw.name) && (typeof raw.name !== 'string' || !NAME.test(raw.name))) bad('invalid name');
  const management = raw.management === true || raw.management === 'true';
  if (!blank(raw.management) && !management && raw.management !== false && raw.management !== 'false') bad('management is true or false');
  const result = { issuer: selected, roles: [...new Set(roles)], management, name: blank(raw.name) ? null : raw.name };
  if (!blank(raw.subject)) {
    if (typeof raw.subject !== 'string' || raw.subject.length > 512 || control(raw.subject)) bad('invalid subject');
    result.subject = raw.subject;
  } else {
    const email = normalEmail(raw.email);
    if (!email) bad('invalid email');
    result.email = email;
  }
  return result;
}

function inline (value, issuer) {
  return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean).map((item, index) => {
    const match = /^(sub|email):(.+)=([^=]+)$/.exec(item);
    if (!match) refuse('OIDC_IDENTITIES entry ' + (index + 1) + ': expected sub:<subject>=<roles> or email:<address>=<roles>');
    return entry({ [match[1] === 'sub' ? 'subject' : 'email']: match[2].trim(), roles: match[3] }, issuer, 'entry ' + (index + 1));
  });
}

function table (value, separator, issuer) {
  const rows = value.split(/\r?\n/).map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() && !line.trimStart().startsWith('#'));
  if (!rows.length) return [];
  // Quoting is not interpreted: a value that needs it belongs in the JSON form.
  if (rows.some(({ line }) => line.includes('"'))) refuse('OIDC identity list: quoted values are not supported; use JSON');
  const header = rows[0].line.split(separator).map(name => name.trim().toLowerCase());
  if (new Set(header).size !== header.length || header.some(name => !FIELDS.includes(name)) || !header.includes('roles')) {
    refuse('OIDC identity list: header names columns from ' + FIELDS.join(', ') + ' and includes roles');
  }
  return rows.slice(1).map(({ line, number }) => {
    const cells = line.split(separator).map(cell => cell.trim());
    if (cells.length !== header.length) refuse('OIDC identity list line ' + number + ': expected ' + header.length + ' columns');
    return entry(Object.fromEntries(header.map((name, i) => [name, cells[i]])), issuer, 'line ' + number);
  });
}

function json (value, issuer) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { refuse('OIDC identity list: invalid JSON'); }
  if (!Array.isArray(parsed)) refuse('OIDC identity list: JSON form is an array of entries');
  return parsed.map((item, index) => entry(item, issuer, 'entry ' + (index + 1)));
}

function loadIdentityList ({ source = process.env, issuer }) {
  const { value, filename } = privateSource(source, 'OIDC_IDENTITIES', { limit: 262144 });
  let entries = [];
  if (value !== undefined) {
    if (filename) {
      const extension = path.extname(filename).toLowerCase();
      if (extension === '.json') entries = json(value, issuer);
      else if (extension === '.csv') entries = table(value, ',', issuer);
      else if (extension === '.tsv') entries = table(value, '\t', issuer);
      else refuse('OIDC_IDENTITIES_FILE must end in .csv, .tsv or .json');
    } else entries = value.trimStart().startsWith('[') ? json(value, issuer) : inline(value, issuer);
  }
  if (entries.length > MAX_PRINCIPALS) refuse('OIDC identity list holds at most ' + MAX_PRINCIPALS + ' entries');
  const keys = entries.map(item => JSON.stringify([item.issuer, item.subject ? 'sub' : 'email', item.subject || item.email]));
  if (new Set(keys).size !== keys.length) refuse('OIDC identity list names the same identity twice');
  const fallbackRoles = [...new Set((source.OIDC_FALLBACK_ROLES || '').split(/[\s,:+]+/).filter(Boolean))];
  if (fallbackRoles.some(role => !ROLE.test(role))) refuse('OIDC_FALLBACK_ROLES holds role names');
  return Object.freeze({ entries: Object.freeze(entries), fallbackRoles: Object.freeze(fallbackRoles),
    requestEmail: entries.some(item => item.email !== undefined) });
}

module.exports = { loadIdentityList };
