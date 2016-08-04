'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var shiroTrie = require('shiro-trie');
var ObjectID = require('mongodb').ObjectID;

var find_options = require('../query');

function init (env, ctx) {
  var storage = { };

  var rolesCollection = ctx.store.collection(env.authentication_collections_prefix + 'roles');
  var subjectsCollection = ctx.store.collection(env.authentication_collections_prefix + 'subjects');

  storage.queryOpts = {
    dateField: 'created_at'
  };

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  storage.createSubject = function createSubject (obj, fn) {
    if (! obj.hasOwnProperty('created_at')){
      obj.created_at = (new Date()).toISOString();
    }
    subjectsCollection.insert(obj, function (err, doc) {
      storage.reload(function loaded ( ) {
        fn(null, doc.ops);
      });
    });
  };

  // query for entries from storage
  storage.listSubjects = function listSubjects (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort ( ) {
      return opts && opts.sort || {date: -1};
    }

    // configure the limit portion of the current query
    function limit ( ) {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    // handle all the results
    function toArray (err, entries) {
      fn(err, entries);
    }

    // now just stitch them all together
    limit.call(subjectsCollection
        .find(query_for(opts))
        .sort(sort( ))
    ).toArray(toArray);
  };

  storage.removeSubject = function removeSubject (_id, callback) {
    subjectsCollection.remove({ '_id': new ObjectID(_id) }, function (err) {
      storage.reload(function loaded() {
        callback(err, null);
      });
    });
  };

  storage.saveSubject = function saveSubject (obj, callback) {
    obj._id = new ObjectID(obj._id);
    if (!obj.created_at) {
      obj.created_at = (new Date( )).toISOString( );
    }
    subjectsCollection.save(obj, function (err) {
      //id should be added for new docs
      storage.reload(function loaded() {
        callback(err, obj);
      });
    });
  };

  storage.reload = function reload (callback) {
    //TODO: load from mongo
    storage.roles = [
      {name: 'admin', permissions: ['*']}
      ,
      {name: 'careportal', permissions: ['api:treatments:create', 'alarms:default:ack']}
    ];

    storage.listSubjects({sort: {name: 1}}, function listResults (err, results) {

      if (!err) {
        storage.subjects = _.map(results, function eachSubject (subject) {
          if (env.api_secret) {
            var shasum = crypto.createHash('sha1');
            shasum.update(env.api_secret);
            shasum.update(subject._id.toString());
            var digest = shasum.digest('base64').substring(0, 10);
            var abbrev = subject.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
            subject.digest = digest;
            subject.accessToken = abbrev + '-' + encodeURIComponent(digest);
          }

          return subject;
        });
      }

      if (callback) {
        callback(err);
      }

    });

  };

  storage.rolesToPermissions = function rolesToPermissions (roleNames) {
    var permissions = [ ];

    _.forEach(roleNames, function eachRoleName (roleName) {
      if (storage.roles) {
        var role = _.find(storage.roles, {name: roleName});
        if (role) {
          permissions = permissions.concat(role.permissions);
        }
      }
    });

    return _.uniq(permissions);
  };

  storage.findSubject = function findSubject (accessToken) {
    var prefix = _.last(accessToken.split('-'));

    if (prefix.length < 8) {
      return null;
    }

    return _.find(storage.subjects, function matches (subject) {
      return subject.digest.indexOf(prefix) === 0;
    });
  };

  storage.findSubjectPermissions = function findSubjectPermissions (accessToken) {
    var permissions = shiroTrie.new();

    var subject = storage.findSubject(accessToken);
    if (subject) {
      console.info('Found Subject', subject);
      permissions.add(storage.rolesToPermissions(subject.roles));
    }

    return permissions;
  };

  return storage;

}

module.exports = init;
