'use strict';

const assert = require('node:assert/strict');
const {generateKeyPairSync} = require('node:crypto');
const {createRequire} = require('node:module');
const fromAPN = createRequire(require.resolve('@parse/node-apn'));
const consumers = [['Nightscout', require('jsonwebtoken')], ['APN', fromAPN('jsonwebtoken')]];

// jsonwebtoken uses semver at module initialization to select supported key
// validation paths. Exercise both installed production consumers with real keys.
describe('semver-dependent JWT key validation', function () {
  const ec = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
  const pss = generateKeyPairSync('rsa-pss', {modulusLength: 2048, hashAlgorithm: 'sha256', mgf1HashAlgorithm: 'sha256', saltLength: 32});
  for (const [name, jwt] of consumers) {
    for (const [algorithm, keys] of [['ES256', ec], ['RS256', rsa], ['PS256', pss]]) {
      it(name + ' signs and validates ' + algorithm + ' while rejecting an incorrect algorithm', function () {
        for (let cycle = 0; cycle < 2; cycle++) {
          const token = jwt.sign({fixture: 'owned', cycle}, keys.privateKey, {algorithm, expiresIn: 60});
          const verified = jwt.verify(token, keys.publicKey, {algorithms: [algorithm]});
          assert.equal(verified.fixture, 'owned');
          assert.equal(verified.cycle, cycle);
          assert.throws(() => jwt.verify(token, keys.publicKey, {algorithms: ['HS256']}), /invalid algorithm/);
        }
      });
    }
    it(name + ' rejects a mismatched EC curve during signing', function () {
      assert.throws(() => jwt.sign({fixture: 'owned'}, ec.privateKey, {algorithm: 'ES384'}), /curve/);
    });
  }
});
