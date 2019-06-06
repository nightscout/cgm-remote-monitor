'use strict';

const _ = require('lodash');
  
function configure (authStorage) {
  
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
    const subjects = { };
    subjects.admin = await createTestSubject('admin', [ 'admin' ]);
    subjects.readable = await createTestSubject('readable', [ 'readable' ]);
    subjects.denied = await createTestSubject('denied', [ 'denied' ]);
    resolve(subjects);
  });
}

module.exports = configure;