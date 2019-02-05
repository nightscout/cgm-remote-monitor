'use strict';

function configure (ctx, env, done) {
  var storage = require('../../../lib/authorization/storage')(ctx, env)
    , _ = require('lodash')
    , subjects = { }

  function createTestSubject (subjectName, roles, next) {
    var subjectDbName = 'test-' + subjectName
      , subject = _.find(storage.subjects, { name: subjectDbName })

    if (subject) {
      subjects[subjectName] = subject;
      next();
    }
    else {
      storage.createSubject({
        "name": subjectDbName,
        "roles": roles,
        "notes": ""
      }, function afterCreate (err) {

        if (err) throw err;
        subjects[subjectName] = _.find(storage.subjects, { name: subjectDbName });
        next();
      });
    }
  }

  storage.reload(function reloaded () {
    
    createTestSubject('admin', [ 'admin' ], function () {
      createTestSubject('readable', [ 'readable' ], function () {
        createTestSubject('denied', [ 'denied' ], function () {
          done(subjects);
        })
      })
    })
  });

  return subjects;
}

module.exports = configure;