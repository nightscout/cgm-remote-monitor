'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {MongoClient, BSON} = require('mongodb');
const {MongoDBAWS} = require('mongodb/lib/cmap/auth/mongodb_aws');
const configure = require('../lib/storage/mongo-client-configuration');

const awsUri = 'mongodb://127.0.0.1/test?authMechanism=MONGODB-AWS&authSource=%24external';
const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

describe('MongoDB AWS credential compatibility', function () {
  let original;
  beforeEach(function () {
    original = keys.map(key => [key, process.env[key]]);
    keys.forEach(key => {delete process.env[key];});
  });
  afterEach(function () {
    original.forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  });

  async function authenticate(uri, expected) {
    const config = configure(uri, {maxPoolSize:5});
    const client = new MongoClient(config.uri, config.options);
    const credentials = client.options.credentials;
    const provider = new MongoDBAWS(credentials.mechanismProperties.AWS_CREDENTIAL_PROVIDER);
    const commands = [];
    // Run the driver's real nonce handling, credential provider and signer.
    // The fixture connection returns a challenge; no network or Atlas access.
    const connection = {async command(namespace, command) {
      commands.push(command);
      if (command.saslStart) {
        const challenge = BSON.deserialize(command.payload);
        return {conversationId:17, payload:new BSON.Binary(BSON.serialize({
          h:'sts.amazonaws.com', s:new BSON.Binary(Buffer.concat([challenge.r.buffer, Buffer.alloc(32, 1)]))
        }))};
      }
      const response = BSON.deserialize(command.payload);
      assert(response.a.includes('Credential=' + expected.accessKeyId + '/'));
      assert.equal(response.t, expected.sessionToken);
      return {ok:1};
    }};
    try {
      await provider.auth({connection, credentials});
      assert.equal(commands.length, 2);
      assert.equal(commands[1].conversationId, 17);
      assert.equal(client.options.maxPoolSize, 5);
    } finally {await client.close();}
  }

  it('preserves encoded URI credentials and session token through two authentications', async function () {
    const accessKeyId = 'fixture/access+key';
    const secretAccessKey = 'fixture:/%secret';
    const sessionToken = 'fixture/+token==:suffix';
    const uri = awsUri.replace('127.0.0.1', encodeURIComponent(accessKeyId) + ':' + encodeURIComponent(secretAccessKey) + '@127.0.0.1')
      + '&authMechanismProperties=' + encodeURIComponent('AWS_SESSION_TOKEN:' + sessionToken);
    assert.throws(() => new MongoClient(uri), /username and password cannot be provided/);
    const config = configure(uri);
    assert(!config.uri.includes('fixture'));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await config.options.authMechanismProperties.AWS_CREDENTIAL_PROVIDER(), {accessKeyId, secretAccessKey, sessionToken});
      await authenticate(uri, {accessKeyId, sessionToken});
    }
    keys.forEach(key => assert.equal(process.env[key], undefined));
  });

  it('keeps URI credentials ahead of conflicting environment values', async function () {
    process.env.AWS_ACCESS_KEY_ID = 'environment-access';
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    process.env.AWS_SESSION_TOKEN = 'environment-token';
    await authenticate(awsUri.replace('127.0.0.1', 'uri-access:uri-secret@127.0.0.1')
      + '&authMechanismProperties=AWS_SESSION_TOKEN:uri-token', {accessKeyId:'uri-access', sessionToken:'uri-token'});
    assert.equal(process.env.AWS_ACCESS_KEY_ID, 'environment-access');
    assert.equal(process.env.AWS_SESSION_TOKEN, 'environment-token');
  });

  it('retains environment fallback for missing URI secret and session token', async function () {
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    process.env.AWS_SESSION_TOKEN = 'environment-token';
    const config = configure(awsUri.replace('127.0.0.1', 'uri-access@127.0.0.1'));
    assert.deepEqual(await config.options.authMechanismProperties.AWS_CREDENTIAL_PROVIDER(), {
      accessKeyId:'uri-access', secretAccessKey:'environment-secret', sessionToken:'environment-token'
    });
    await authenticate(awsUri.replace('127.0.0.1', 'uri-access@127.0.0.1'), {accessKeyId:'uri-access', sessionToken:'environment-token'});
  });

  it('uses environment credentials without requiring a URI username', async function () {
    process.env.AWS_ACCESS_KEY_ID = 'environment-access';
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    await authenticate(awsUri, {accessKeyId:'environment-access'});
  });

  it('leaves metadata credential retrieval to the driver SDK provider', function () {
    const options = {maxPoolSize:5};
    const config = configure(awsUri, options);
    assert.equal(config.options, options);
    const client = new MongoClient(config.uri, config.options);
    assert.equal(client.options.credentials.mechanismProperties.AWS_CREDENTIAL_PROVIDER, undefined);
    return client.close();
  });

  it('retains mixed-case URI options and unrelated authentication properties', async function () {
    const uri = awsUri.replace('authMechanism=', 'AUTHMECHANISM=').replace('127.0.0.1', 'fixture:secret@127.0.0.1')
      + '&authMechanismProperties=AWS_SESSION_TOKEN:token,OTHER:value&retryWrites=false';
    const config = configure(uri);
    const client = new MongoClient(config.uri, config.options);
    try {
      assert.equal(client.options.credentials.mechanismProperties.OTHER, 'value');
      assert.equal(typeof client.options.credentials.mechanismProperties.AWS_CREDENTIAL_PROVIDER, 'function');
      assert.equal(client.options.retryWrites, false);
    } finally {await client.close();}
  });

  it('retains repeated mechanism properties and last session-token precedence', async function () {
    const uri = awsUri.replace('127.0.0.1', 'fixture:secret@127.0.0.1')
      + '&authMechanismProperties=FIRST:one,AWS_SESSION_TOKEN:first'
      + '&authMechanismProperties=SECOND:two,AWS_SESSION_TOKEN:second';
    const config = configure(uri);
    const client = new MongoClient(config.uri, config.options);
    try {
      const properties = client.options.credentials.mechanismProperties;
      assert.equal(properties.FIRST, 'one');
      assert.equal(properties.SECOND, 'two');
      assert.equal((await properties.AWS_CREDENTIAL_PROVIDER()).sessionToken, 'second');
    } finally {await client.close();}
  });

  it('adapts credentials through storage initialization on successive connections', async function () {
    const originalConnect = MongoClient.prototype.connect;
    const originalDb = MongoClient.prototype.db;
    let connections = 0;
    MongoClient.prototype.connect = async function () {
      const credentials = await this.options.credentials.mechanismProperties.AWS_CREDENTIAL_PROVIDER();
      assert.equal(credentials.accessKeyId, 'storage-fixture');
      connections++;
      return this;
    };
    MongoClient.prototype.db = () => ({command:async () => ({authInfo:{authenticatedUserRoles:[]}})});
    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    const storage = require('../lib/storage/mongo-storage');
    let result;
    try {
      const env = {storageURI:awsUri.replace('127.0.0.1', 'storage-fixture:secret@127.0.0.1')};
      result = await storage(env, undefined, true);
      result = await storage(env, undefined, true);
      assert.equal(connections, 2);
    } finally {
      if (result?.client) await result.client.close();
      MongoClient.prototype.connect = originalConnect;
      MongoClient.prototype.db = originalDb;
      delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    }
  });

  it('rejects incomplete credentials without exposing the configured access key', function () {
    assert.throws(() => configure(awsUri.replace('127.0.0.1', 'private-fixture-key@127.0.0.1')), error => {
      assert(!error.message.includes('private-fixture-key'));
      return /requires a secret access key/.test(error.message);
    });
  });

  it('leaves non-AWS URIs and options unchanged', function () {
    for (const uri of ['mongodb://user:pass@host/test?authMechanism=SCRAM-SHA-256',
      'mongodb+srv://user:pass@owned.example.invalid/test?tls=true']) {
      const options = {maxPoolSize:5};
      assert.deepEqual(configure(uri, options), {uri, options});
    }
  });

  it('retrieves and caches metadata credentials through the real SDK on loopback', function () {
    this.timeout(15000);
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nightscout-aws-test-'));
    const emptyConfig = path.join(directory, 'empty');
    fs.writeFileSync(emptyConfig, '');
    try {
      const result = spawnSync(process.execPath, ['tests/fixtures/mongo-aws-metadata.js'], {
        cwd:path.resolve(__dirname, '..'), encoding:'utf8', timeout:10000,
        env:{HOME:directory, USERPROFILE:directory,
          ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
          AWS_CONFIG_FILE:emptyConfig, AWS_SHARED_CREDENTIALS_FILE:emptyConfig,
          AWS_EC2_METADATA_DISABLED:'true', AWS_REGION:'us-east-1'}
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert(result.stdout.includes('Owned metadata provider passed twice'));
    } finally {fs.rmSync(directory, {recursive:true, force:true});}
  });

  it('does not load AWS SDK modules for ordinary connection configuration', function () {
    const result = spawnSync(process.execPath, ['-e', `
      const configure = require('./lib/storage/mongo-client-configuration');
      const {MongoClient} = require('mongodb');
      const config = configure('mongodb://127.0.0.1/test');
      const client = new MongoClient(config.uri, config.options);
      if (Object.keys(require.cache).some(path => path.includes('/@aws-sdk/'))) process.exitCode = 1;
      client.close();
    `], {cwd:require('node:path').resolve(__dirname, '..'), encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
  });
});
