'use strict';

const _ = require('lodash')
  , request = require('supertest')
  ;
require('should');

function createRole (authStorage, name, permissions) {

  return new Promise((resolve, reject) => {

    let role = _.find(authStorage.roles, { name });

    if (role) {
      resolve(role);
    }
    else {
      authStorage.createRole({
        "name": name,
        "permissions": permissions,
        "notes": ""
      }, function afterCreate (err) {

        if (err)
          reject(err);

        role = _.find(authStorage.roles, { name });
        resolve(role);
      });
    }
  });
}


function createTestSubject (authStorage, subjectName, roles) {

  return new Promise((resolve, reject) => {

    const subjectDbName = 'test-' + subjectName;
    let subject = _.find(authStorage.subjects, { name: subjectDbName });

    if (subject) {
      resolve(subject);
    }
    else {
      authStorage.createSubject({
        "name": subjectDbName,
        "roles": roles,
        "notes": ""
      }, function afterCreate (err) {

        if (err)
          reject(err);

        subject = _.find(authStorage.subjects, { name: subjectDbName });
        resolve(subject);
      });
    }
  });
}


async function initJwts (accessToken, tokensNeeded, app) {
  const jwt = {}
  if (!_.isArray(tokensNeeded) || !app)
    return jwt;

  for (const tokenNeeded of tokensNeeded) {
    jwt[tokenNeeded] = await new Promise((resolve, reject) => {
      try {
        const authToken = accessToken[tokenNeeded];

        request(app)
          .get(`/api/v2/authorization/request/${authToken}`)
          .expect(200)
          .end(function(err, res) {
            if (err)
              reject(err);

            resolve(res.body.token);
          });
      }
      catch (e) {
        reject(e)
      }
    })
  }

  return jwt;
}


async function authSubject (authStorage, tokensNeeded, app) {

  await createRole(authStorage, 'admin', '*');
  await createRole(authStorage, 'readable', '*:*:read');
  await createRole(authStorage, 'apiAll', 'api:*:*');
  await createRole(authStorage, 'apiAdmin', 'api:*:admin');
  await createRole(authStorage, 'apiCreate', 'api:*:create');
  await createRole(authStorage, 'apiRead', 'api:*:read');
  await createRole(authStorage, 'apiUpdate', 'api:*:update');
  await createRole(authStorage, 'apiDelete', 'api:*:delete');
  await createRole(authStorage, 'noneRole', '');

  const subject = {
    apiAll: await createTestSubject(authStorage, 'apiAll', ['apiAll']),
    apiAdmin: await createTestSubject(authStorage, 'apiAdmin', ['apiAdmin']),
    apiCreate: await createTestSubject(authStorage, 'apiCreate', ['apiCreate']),
    apiRead: await createTestSubject(authStorage, 'apiRead', ['apiRead']),
    apiUpdate: await createTestSubject(authStorage, 'apiUpdate', ['apiUpdate']),
    apiDelete: await createTestSubject(authStorage, 'apiDelete', ['apiDelete']),
    admin: await createTestSubject(authStorage, 'admin', ['admin']),
    readable: await createTestSubject(authStorage, 'readable', ['readable']),
    denied: await createTestSubject(authStorage, 'denied', ['denied']),
    noneSubject: await createTestSubject(authStorage, 'noneSubject', null),
    noneRole: await createTestSubject(authStorage, 'noneRole', ['noneRole'])
  };

  const accessToken = {
    all: subject.apiAll.accessToken,
    admin: subject.apiAdmin.accessToken,
    create: subject.apiCreate.accessToken,
    read: subject.apiRead.accessToken,
    update: subject.apiUpdate.accessToken,
    delete: subject.apiDelete.accessToken,
    denied: subject.denied.accessToken,
    adminAll: subject.admin.accessToken,
    readable: subject.readable.accessToken,
    noneSubject: subject.noneSubject.accessToken,
    noneRole: subject.noneRole.accessToken
  };

  const jwt = await initJwts(accessToken, tokensNeeded, app);

  return {subject, accessToken, jwt};
}

module.exports = authSubject;
