'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');
const lower = require('../lib/storage/postgres-connection');
const registryModule = require('../lib/tenant-registry/postgres');
const { publish } = require('../lib/realtime-placement/publish');
const publication = require('../lib/realtime-placement/publication-lock');
const listeners = require('../lib/server/internal-api/listener-config');
optInSuite(enabled(), 'owned PostgreSQL and Vault registry publication')('controlled placement publication and actual maintenance pin', function () {
  this.timeout(60000);
  it('SHARD_PUBLICATION: pin, unknown alive and suspended window refuse without file change; confirmed stopped transition publishes once', async function () {
    let lab, provisioner, reader, client, pinClient, pin, directory, role;
    try {
      lab = await createLab();
      provisioner = require('../lib/tenant-registry/provision').createProvisioning(lab.provisioningOptions());
      const tenant = randomUUID(); await provisioner.provision({ id: tenant, hosts: ['move.example.test'] });
      const password = randomBytes(24).toString('hex'); role = 'placement_op_' + lab.id;
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await lab.admin.query(`GRANT USAGE ON SCHEMA "${lab.namespaces.control}" TO "${role}"`);
      await lab.admin.query(`GRANT SELECT ON "${lab.namespaces.control}".schema_migrations,"${lab.namespaces.control}".tenant_lifecycle_windows,"${lab.namespaces.control}".tenant_lifecycle_operations TO "${role}"`);
      for (const sql of registryModule.grants({ namespace: lab.namespaces.registry, enumerators: [role] })) await lab.admin.query(sql);
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password;
      reader = await lower({ connectionString: url.toString(), max: 1 });
      const registry = registryModule.create({ connection: reader, namespace: lab.namespaces.registry });
      client = new Client({ connectionString: url.toString() }); await client.connect();
      pinClient = new Client({ connectionString: url.toString() }); await pinClient.connect();
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sharding-publication-')); const file = path.join(directory, 'placement.json');
      const oldIncarnation = randomUUID(), newIncarnation = randomUUID(), replacement = randomUUID();
      const original = { version: 1, rule: 'sha256-u32be-v1', shardCount: 1, generation: 1, owners: ['a'], workers: [
        { id: 'a', incarnation: oldIncarnation, address: { socket: '/tmp/native-shard-a.sock' }, consumerOrigin: 'http://127.0.0.1:18001' },
        { id: 'b', incarnation: newIncarnation, address: { socket: '/tmp/native-shard-b.sock' }, consumerOrigin: 'http://127.0.0.1:18002' }] };
      const candidate = { ...original, generation: 2, owners: ['b'], workers: original.workers.map(row => row.id === 'a' ? { ...row, incarnation: replacement } : row),
        transition: { previousGeneration: 1, previousOwners: [{ worker: 'a', incarnation: oldIncarnation }], stopped: [{ worker: 'a', incarnation: oldIncarnation }] } };
      const internal = listeners.resolve(['api'], { NS_SERVE_INTERNAL_SOCKET: '/tmp/native-op.sock' });
      await fs.writeFile(file, JSON.stringify(original)); const before = await fs.readFile(file, 'utf8');
      const input = { file, candidate, internal, client, controlNamespace: lab.namespaces.control, registry, maxTenants: 10, confirmStopped: async () => true };
      pin = await publication.pin(pinClient, lab.namespaces.control);
      await assert.rejects(publish(input), { code: 'REALTIME_PLACEMENT_MAINTENANCE_PINNED' }); assert.equal(await fs.readFile(file, 'utf8'), before);
      await pin.close(); pin = null;
      await assert.rejects(publish({ ...input, confirmStopped: async () => false }), { code: 'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED' });
      assert.equal(await fs.readFile(file, 'utf8'), before);
      await lab.admin.query(`UPDATE "${lab.namespaces.control}".tenant_lifecycle_windows SET phase='suspended',claim_id=$2,artifact_digest=$3 WHERE tenant_id=$1`, [tenant, randomUUID(), 'a'.repeat(64)]);
      await assert.rejects(publish(input), { code: 'LIFECYCLE_WINDOW_SUSPENDED' }); assert.equal(await fs.readFile(file, 'utf8'), before);
      await lab.admin.query(`UPDATE "${lab.namespaces.control}".tenant_lifecycle_windows SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1`, [tenant]);
      const result = await publish({...input,afterAssignment:async value=>{assert.equal(value.generation,2);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),candidate);await assert.rejects(publication.pin(pinClient,lab.namespaces.control),{code:'RESTORE_COHORT_PLACEMENT_BUSY'});}}); assert.equal(result.generation, 2); assert.equal(result.affectedTenants, 1);
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), candidate);
      await assert.rejects(publish(input), { code: 'REALTIME_PLACEMENT_REVISION_REFUSED' });
      assert.deepEqual(await fs.readdir(directory), ['placement.json'], 'no temporary config debris');
    } finally {
      await pin?.close().catch(() => {}); await client?.end().catch(() => {}); await pinClient?.end().catch(() => {}); await reader?.end().catch(() => {}); await provisioner?.close().catch(() => {});
      if (lab) { if (role) { await lab.admin.query(`DROP OWNED BY "${role}"`); await lab.admin.query(`DROP ROLE "${role}"`); } await lab.close(); }
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
