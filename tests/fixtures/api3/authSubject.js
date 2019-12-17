'use strict';

const _ = require('lodash');

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


async function authSubject (authStorage) {

  await createRole(authStorage, 'apiAll', 'api:*:*');
  await createRole(authStorage, 'apiAdmin', 'api:*:admin');
  await createRole(authStorage, 'apiCreate', 'api:*:create');
  await createRole(authStorage, 'apiRead', 'api:*:read');
  await createRole(authStorage, 'apiUpdate', 'api:*:update');
  await createRole(authStorage, 'apiDelete', 'api:*:delete');

  const subject = {
    apiAll: await createTestSubject(authStorage, 'apiAll', ['apiAll']),
    apiAdmin: await createTestSubject(authStorage, 'apiAdmin', ['apiAdmin']),
    apiCreate: await createTestSubject(authStorage, 'apiCreate', ['apiCreate']),
    apiRead: await createTestSubject(authStorage, 'apiRead', ['apiRead']),
    apiUpdate: await createTestSubject(authStorage, 'apiUpdate', ['apiUpdate']),
    apiDelete: await createTestSubject(authStorage, 'apiDelete', ['apiDelete']),
    admin: await createTestSubject(authStorage, 'admin', ['admin']),
    readable: await createTestSubject(authStorage, 'readable', ['readable']),
    denied: await createTestSubject(authStorage, 'denied', ['denied'])
  };

  const token = {
    all: subject.apiAll.accessToken,
    admin: subject.apiAdmin.accessToken,
    create: subject.apiCreate.accessToken,
    read: subject.apiRead.accessToken,
    update: subject.apiUpdate.accessToken,
    delete: subject.apiDelete.accessToken,
    denied: subject.denied.accessToken
  };

  return {subject, token};
}

module.exports = authSubject;