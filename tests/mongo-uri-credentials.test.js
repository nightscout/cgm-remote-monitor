'use strict';
const assert = require('node:assert/strict');
const matches = require('../lib/utils/mongo-password-matches');
const {MongoClient} = require('mongodb');

describe('MongoDB driver credential parsing', function () {
  const secret = 'owned :/@?% password';
  const auth = 'owned:' + encodeURIComponent(secret) + '@';
  const valid = [
    'mongodb://' + auth + 'localhost/test',
    'mongodb://' + auth + 'host1:27017,host2:27018/test?replicaSet=owned',
    'mongodb://' + auth + '[::1]:27017/test',
    'mongodb+srv://' + auth + 'owned.example.invalid/test?retryWrites=true&w=majority',
    'mongodb://' + auth + 'localhost/test?authMechanism=SCRAM-SHA-256&authSource=admin&tls=true&tlsCAFile=/owned/nonexistent.pem'
  ];
  for (const uri of valid) {
    it('compares decoded credentials for ' + uri.slice(uri.indexOf('@') + 1), function () {
      assert.equal(matches(uri, secret), true);
      assert.equal(matches(uri, 'different owned password'), false);
    });
  }
  it('does not invent credentials for unauthenticated connections', function () {
    assert.equal(matches('mongodb://localhost/test', secret), false);
    assert.equal(matches('mongodb+srv://owned.example.invalid/test', secret), false);
  });
  it('rejects malformed MongoDB URI grammar', function () {
    for (const uri of ['https://localhost/test', 'mongodb://', 'mongodb://owned:%ZZ@localhost/test',
      'mongodb+srv://host1,host2/test']) {
      assert.throws(() => matches(uri, secret));
    }
  });
  it('leaves option validation to the connection driver', function () {
    assert.equal(matches('mongodb://' + auth + 'localhost/test?notAnOption=true', secret), true);
  });
  it('never calls connect while inspecting credentials', function () {
    const original = MongoClient.prototype.connect;
    MongoClient.prototype.connect = () => assert.fail('Credential comparison must not connect');
    try {
      for (const uri of valid) assert.equal(matches(uri, secret), true);
    } finally {MongoClient.prototype.connect = original;}
  });
});

describe('MongoDB credential warning in environment configuration', function () {
  it('warns only for the matching decoded password on successive configurations', function () {
    const keys = ['API_SECRET', 'CUSTOMCONNSTR_mongo'];
    const original = new Map(keys.map(key => [key, process.env[key]]));
    const secret = 'owned:encoded/@ secret';
    try {
      for (const password of [secret, 'different owned password']) {
        process.env.API_SECRET = secret;
        process.env.CUSTOMCONNSTR_mongo = 'mongodb://owned:' + encodeURIComponent(password) + '@localhost/test';
        const env = require('../lib/server/env')();
        const warnings = env.notifies.filter(item => item.message.includes('MongoDB password and API_SECRET match'));
        assert.equal(warnings.length, password === secret ? 1 : 0);
      }
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
