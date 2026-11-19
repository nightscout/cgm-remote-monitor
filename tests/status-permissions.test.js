'use strict';

require('should');

const express = require('express')
  , request = require('supertest')
  , shiroTrie = require('shiro-trie')
  , configureStatus = require('../lib/api3/specific/status')
  ;

describe('API3 status collection permissions', function () {
  async function permissionsFor (grants) {
    const app = express();
    const shiro = shiroTrie.new();
    grants.forEach(function addGrant (grant) { shiro.add(grant); });

    app.set('API3_SECURITY_ENABLE', true);
    app.set('collections', {
      entries: { colName: 'entries' }
      , treatments: { colName: 'treatments' }
      , settings: { colName: 'settings' }
    });
    app.set('entriesCollection', {
      storage: { version: async function () { return 'test'; } }
    });

    const ctx = {
      authorization: {
        resolve: function (subject, callback) {
          callback(null, { shiros: [shiro] });
        }
      }
    };
    app.use('/api/v3', configureStatus(app, ctx, { trustProxy: false }));

    const res = await request(app).get('/api/v3/status')
      .set('Authorization', 'Bearer fixture-token')
      .expect(200);

    return res.body.result.apiPermissions;
  }

  it('reports scoped grants and omits inaccessible collections', async () => {
    const permissions = await permissionsFor([
      'api:entries:read', 'api:treatments:create', 'api:treatments:read'
    ]);

    permissions.should.eql({ entries: 'r', treatments: 'cr' });
  });

  it('reports wildcard read access without write permissions', async () => {
    const permissions = await permissionsFor(['api:*:read']);

    permissions.should.eql({ entries: 'r', treatments: 'r', settings: 'r' });
  });

  it('reports all operations for an administrator', async () => {
    const permissions = await permissionsFor(['*']);

    permissions.should.eql({
      entries: 'crud', treatments: 'crud', settings: 'crud'
    });
  });

  it('reports no collection permissions without grants', async () => {
    const permissions = await permissionsFor([]);

    permissions.should.eql({});
  });
});
