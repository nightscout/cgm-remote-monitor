'use strict';

// Run only as an isolated child with empty AWS config files and environment.
const assert = require('node:assert/strict');
const http = require('node:http');
const {MongoClient} = require('mongodb');
const {AWSSDKCredentialProvider} = require('mongodb/lib/cmap/auth/aws_temporary_credentials');
const configure = require('../../lib/storage/mongo-client-configuration');

(async function () {
  let requests = 0;
  const now = Date.now;
  let clockOffset = 0;
  Date.now = () => now() + clockOffset;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'owned-metadata-token');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({AccessKeyId:'owned-metadata-access', SecretAccessKey:'owned-metadata-secret',
      Token:'owned-session-token-' + requests, Expiration:new Date(Date.now() + 3600000).toISOString()}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://127.0.0.1:' + server.address().port + '/credentials';
  process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = 'owned-metadata-token';
  const config = configure('mongodb://127.0.0.1/test?authMechanism=MONGODB-AWS');
  const client = new MongoClient(config.uri, config.options);
  try {
    const provider = new AWSSDKCredentialProvider(client.options.credentials.mechanismProperties.AWS_CREDENTIAL_PROVIDER);
    for (let cycle = 0; cycle < 2; cycle++) {
      clockOffset = cycle * 3600001;
      for (let i = 0; i < 2; i++) {
        const credentials = await provider.getCredentials();
        assert.equal(credentials.AccessKeyId, 'owned-metadata-access');
        assert.equal(credentials.SecretAccessKey, 'owned-metadata-secret');
        assert.equal(credentials.Token, 'owned-session-token-' + (cycle + 1));
      }
      assert.equal(requests, cycle + 1, 'Refresh expired credentials and reuse unexpired credentials');
    }
    console.log('Owned metadata provider passed twice');
  } finally {
    Date.now = now;
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
