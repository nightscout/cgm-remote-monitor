'use strict';

const assert = require('node:assert/strict');
const { createSubjectAdmin } = require('../lib/subject-admin/component');
const context = { tenant: '11111111-1111-4111-8111-111111111111', principal: 'manager', consumer: 'admin' };

describe('bounded subject administration contract', function () {
  it('requires management authority and never defaults a supplied data principal into management', async function () {
    let writes = 0;
    const service = createSubjectAdmin({
      store: { async update () { writes++; }, async remove () { writes++; } },
      async authorizeManagement (actor, action) {
        assert.deepEqual(action, { operation: 'update', subjectId: 'subject' });
        assert.equal(actor.principal, 'data-subject');
        return false;
      }
    });
    await assert.rejects(service.update({ ...context, principal: 'data-subject' }, 'subject', { name: 'Display' }),
      { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    const unavailable = createSubjectAdmin({ store: { async update () { writes++; }, async remove () { writes++; } },
      async authorizeManagement () { throw new Error('management unavailable'); } });
    await assert.rejects(unavailable.update(context, 'subject', { name: 'Display' }), /management unavailable/);
    assert.equal(writes, 0);
    assert.throws(() => createSubjectAdmin({ store: {} }), TypeError);
  });

  it('copies bounded input, removes omitted roles, and leaves omitted notes/time for the stored merge', async function () {
    let captured;
    const service = createSubjectAdmin({ store: {
      async update (actor, id, value) { captured = value; return { subjectId: id, ...value }; },
      async remove () { return true; }
    }, authorizeManagement: async () => true });
    await service.update(context, 'subject', { name: 'Display' });
    assert.deepEqual(captured, { name: 'Display', roles: [] });
    await service.update(context, 'subject', { name: 'Display', notes: '', created_at: '', roles: ['known'] });
    assert.deepEqual(captured, { name: 'Display', notes: '', roles: ['known'] });
    await service.remove(context, 'subject');
  });

  it('rejects invalid identity, derived credential fields, duplicate roles and malformed metadata', async function () {
    const service = createSubjectAdmin({ store: { async update () {}, async remove () {} },
      authorizeManagement: async () => true });
    for (const input of [{}, { name: ' ' }, { name: 'Name', accessToken: 'derived' },
      { name: 'Name', roles: ['same', 'same'] }, { name: 'Name', roles: ['bad role'] },
      { name: 'Name', notes: null }, { name: 'Name', created_at: 'invalid' }]) {
      await assert.rejects(service.update(context, 'subject', input), TypeError);
    }
    await assert.rejects(service.update({ ...context, tenant: 'invalid' }, 'subject', { name: 'Name' }), TypeError);
    await assert.rejects(service.update(context, '../subject', { name: 'Name' }), TypeError);
    await assert.rejects(service.update(context, 'missing', { name: 'Name' }), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
    await assert.rejects(service.remove(context, 'missing'), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
  });
});
