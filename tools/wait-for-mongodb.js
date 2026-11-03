'use strict';

// CI: wait until the MongoDB the workflow started answers a ping.
//
// supercharge/mongodb-github-action starts a single-node container and
// returns without waiting for it. When mongod never came up, every database
// test failed in its before-all hook instead (212 failing in 47 minutes,
// pull_request run 40532337252). This fails within about 90 seconds, with the
// container's log and the runner's kernel: MongoDB 8.0 refuses to start on
// Linux 6.19 and newer (SERVER-121912), and only some hosted runners have it.

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { MongoClient } = require('mongodb');

const URL = process.env.WAIT_MONGODB_URL || 'mongodb://127.0.0.1:27017/';
const CONTAINER = process.env.WAIT_MONGODB_CONTAINER || 'mongodb';
const ATTEMPTS = Number(process.env.WAIT_MONGODB_ATTEMPTS || 30);

async function ping () {
  const client = new MongoClient(URL, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
  try {
    await client.connect();
    const build = await client.db('admin').command({ buildInfo: 1 });
    return build.version;
  } finally {
    await client.close();
  }
}

function containerLog () {
  try {
    return execFileSync('docker', ['logs', '--tail', '200', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return 'docker logs ' + CONTAINER + ' failed: ' + (err.stderr || err.message);
  }
}

async function main () {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const version = await ping();
      console.log('MongoDB ' + version + ' answers at ' + URL + ' (attempt ' + attempt + '); runner kernel '
        + os.type() + ' ' + os.release());
      return 0;
    } catch (err) {
      last = err;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  console.error('MongoDB did not answer at ' + URL + ' after ' + ATTEMPTS + ' attempts: ' + (last && last.message));
  console.error('Runner kernel: ' + os.type() + ' ' + os.release());
  console.error(containerLog());
  return 1;
}

main().then(code => process.exit(code));
