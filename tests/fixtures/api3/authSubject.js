'use strict';

const _ = require('lodash');
  
function configure (authStorage) {
  
  function createRole (name, permissions) {
    
    return new Promise((resolve, reject) => {

      let role = _.find(authStorage.roles, { name })

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


  function createTestSubject (subjectName, roles) {
    
    return new Promise((resolve, reject) => {

      const subjectDbName = 'test-' + subjectName;
      let subject = _.find(authStorage.subjects, { name: subjectDbName })

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


  return new Promise(async function (resolve, reject) {
    await createRole('apiAll', 'api:*:*');
    await createRole('apiCreate', 'api:*:create');
    await createRole('apiRead', 'api:*:read');
    await createRole('apiUpdate', 'api:*:update');
    await createRole('apiDelete', 'api:*:delete');

    const subject = { 
      apiAll: await createTestSubject('apiAll', [ 'apiAll' ]),
      apiCreate: await createTestSubject('apiCreate', [ 'apiCreate' ]),
      apiRead: await createTestSubject('apiRead', [ 'apiRead' ]),
      apiUpdate: await createTestSubject('apiUpdate', [ 'apiUpdate' ]),
      apiDelete: await createTestSubject('apiDelete', [ 'apiDelete' ]),
      admin: await createTestSubject('admin', [ 'admin' ]),
      readable: await createTestSubject('readable', [ 'readable' ]),
      denied: await createTestSubject('denied', [ 'denied' ])
    };

    const token = {
      all: subject.apiAll.accessToken,
      create: subject.apiCreate.accessToken,
      read: subject.apiRead.accessToken,
      update: subject.apiUpdate.accessToken,
      delete: subject.apiDelete.accessToken
    }

    resolve({ subject, token });
  });
}

module.exports = configure;