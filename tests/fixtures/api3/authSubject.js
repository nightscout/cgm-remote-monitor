'use strict';

function configure (ctx, env, authStorage, done) {
  var _ = require('lodash')
    , subjects = { }

  function createTestSubject (subjectName, roles, next) {
    var subjectDbName = 'test-' + subjectName
      , subject = _.find(authStorage.subjects, { name: subjectDbName })

    if (subject) {
      subjects[subjectName] = subject;
      next();
    }
    else {
      authStorage.createSubject({
        "name": subjectDbName,
        "roles": roles,
        "notes": ""
      }, function afterCreate (err) {

        if (err) throw err;
        subjects[subjectName] = _.find(authStorage.subjects, { name: subjectDbName });
        next();
      });
    }
  }

  createTestSubject('admin', [ 'admin' ], function () {
    createTestSubject('readable', [ 'readable' ], function () {
      createTestSubject('denied', [ 'denied' ], function () {
        done(subjects);
      })
    })
  })

  return subjects;
}

module.exports = configure;