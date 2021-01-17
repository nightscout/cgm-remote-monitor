'use strict;'

const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');


// this is a class for holding potentially sensitive data in the app
// the class also implement functions to use the data, so the data is not shared outside the class

const init = function init () {

  const enclave = {};
  const secrets = {};
  const apiKey = Symbol('api-secret');
  const apiKeySHA1 = Symbol('api-secret');
  const apiKeySHA512 = Symbol('api-secret');
  const jwtKey = Symbol('jwtkey');

  function readKey (filename) {
    let filePath = path.resolve(__dirname + '/../../tmp/' + filename);
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
    return data.digest('hex');
  }

  enclave.setApiKey = function setApiKey (keyValue) {
    secrets[apiKey] = keyValue;
    secrets[apiKeySHA1] = genHash(keyValue,'sha1');
    secrets[apiKeySHA512] = genHash(keyValue,'sha512');
  }

  enclave.isApiKey = function isApiKey (keyValue) {
    return keyValue == secrets[apiKey] || keyValue == secrets[apiKeySHA1] || keyValue == secrets[apiKeySHA512];
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

  return enclave;
}

module.exports = init;
