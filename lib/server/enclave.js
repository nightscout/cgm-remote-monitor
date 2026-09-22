'use strict;'

const path = require('path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');

// this is a class for holding potentially sensitive data in the app
// the class also implement functions to use the data, so the data is not shared outside the class

const init = function init () {

  const enclave = {};
  const secrets = {};
  const apiKey = Symbol('api-secret');
  const apiKeySHA1 = Symbol('api-secretSHA1');
  const apiKeySHA512 = Symbol('api-secretSHA512');
  const jwtKey = Symbol('jwtkey');
  let apiKeySet = false;

  function readKey (filename) {
    let filePath = path.resolve(__dirname + '/../../node_modules/.cache/_ns_cache/' + filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath).toString().trim();
    }
    console.error('Key file ', filePath, 'not found');
    return null;
  }

  secrets[jwtKey] = readKey('randomString');

  function genHash(data, algorihtm) {
    const hash = crypto.createHash(algorihtm);
    data = hash.update(data, 'utf-8');
    return data.digest('hex').toLowerCase();
  }

  enclave.setApiKey = function setApiKey (keyValue) {
    if (keyValue.length < 12) return;
    apiKeySet = true;
    secrets[apiKey] = keyValue;
    secrets[apiKeySHA1] = genHash(keyValue,'sha1');
    secrets[apiKeySHA512] = genHash(keyValue,'sha512');
  }

  enclave.isApiKeySet = function isApiKeySet () {
    return apiKeySet;
  }

  enclave.isApiKey = function isApiKey (keyValue) {
    return keyValue.toLowerCase() == secrets[apiKeySHA1] || keyValue == secrets[apiKeySHA512];
  }

  enclave.setJWTKey = function setJWTKey (keyValue) {
    secrets[jwtKey] = keyValue;
  }

  enclave.signJWT = function signJWT(token, lifetime) {
    const lt = lifetime ? lifetime : '8h';
    return jwt.sign(token, secrets[jwtKey], { expiresIn: lt });
  }

  enclave.verifyJWT = function verifyJWT(tokenString) {
    try {
      return jwt.verify(tokenString, secrets[jwtKey]);
    } catch(err) {
      return null;
    }
  }

  enclave.getSubjectHash = function getSubjectHash(id) {
    var shasum = crypto.createHash('sha1');
    shasum.update(secrets[apiKeySHA1]);
    shasum.update(id);
    return shasum.digest('hex').toLowerCase();
  }

  // This key is stable across builds/restarts, unlike the JWT signing key.
  // Never expose the underlying API secret or derived key to callers.
  function connectorKey () {
    if (!apiKeySet) throw new Error('Connector encryption requires API_SECRET');
    return crypto.hkdfSync('sha256', secrets[apiKey], 'nightscout-connect-v1', 'carelink', 32);
  }

  enclave.sealConnector = function sealConnector(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', connectorKey(), iv);
    cipher.setAAD(Buffer.from('nightscout:carelink:v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };

  enclave.openConnector = function openConnector(value) {
    if (!value || value.version !== 1) throw new Error('Invalid connector record');
    const decipher = crypto.createDecipheriv('aes-256-gcm', connectorKey(), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from('nightscout:carelink:v1'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
  };

  return enclave;
}

module.exports = init;
