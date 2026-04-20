'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var shiroTrie = require('shiro-trie');
var ObjectID = require('mongodb').ObjectId;
var runWithCallback = require('../storage/run-with-callback');

var find_options = require('../server/query');

function init (env, ctx) {
  var storage = { };

  var rolesCollection = ctx.store.collection(env.authentication_collections_prefix + 'roles');
  var subjectsCollection = ctx.store.collection(env.authentication_collections_prefix + 'subjects');

  storage.queryOpts = {
    dateField: 'created_at'
    , noDateFilter: true
  };

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  function normalizeRequiredObjectId(id) {
    if (id === undefined || id === null || id === '') {
      return { error: 'Missing _id for update' };
    }

    try {
      return { value: new ObjectID(id) };
    } catch (err) {
      return { error: 'Invalid _id format: ' + String(id) };
    }
  }

  function create (collection) {
    function doCreate(obj, fn) {
      if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
        obj.created_at = (new Date()).toISOString();
      }

      return runWithCallback(async function () {
        try {
          await collection.insertOne(obj);
        } catch (err) {
          if (err != null && err.message) {
            console.log('Data insertion error', err.message);
            throw err.message;
          }
          throw err;
        }

        await storageReload();
        return obj;
      }, fn);
    }
    return doCreate;
  }

  function list (collection) {
    function doList(opts, fn) {
      // these functions, find, sort, and limit, are used to
      // dynamically configure the request, based on the options we've
      // been given

      // determine sort options
      function sort() {
        return opts && opts.sort || {date: -1};
      }

      // configure the limit portion of the current query
      function limit() {
        if (opts && opts.count) {
          return this.limit(parseInt(opts.count));
        }
        return this;
      }

      console.log('Loading',opts);

      return runWithCallback(function () {
        return limit.call(collection
          .find(query_for(opts))
          .sort(sort())
        ).toArray();
      }, fn);
    }

    return doList;
  }

  function remove (collection) {
    function doRemove (_id, callback) {
      return runWithCallback(async function () {
        await collection.deleteOne({ '_id': new ObjectID(_id) });
        await storageReload();
        return null;
      }, callback);
    }
    return doRemove;
  }

  function save (collection) {
    function doSave (obj, callback) {
      var idResult = normalizeRequiredObjectId(obj && obj._id);
      if (idResult.error) {
        callback(idResult.error, null);
        return;
      }

      obj._id = idResult.value;
      if (!obj.created_at) {
        obj.created_at = (new Date()).toISOString();
      }

      return runWithCallback(async function () {
        await collection.replaceOne({ _id: obj._id }, obj, { upsert: true });
        await storageReload();
        return obj;
      }, callback);
    }
    return doSave;
  }

  storage.createSubject = create(subjectsCollection);
  storage.saveSubject = save(subjectsCollection);
  storage.removeSubject = remove(subjectsCollection);
  storage.listSubjects = list(subjectsCollection);

  storage.createRole = create(rolesCollection);
  storage.saveRole = save(rolesCollection);
  storage.removeRole = remove(rolesCollection);
  storage.listRoles = list(rolesCollection);

  storage.defaultRoles = [
    { name: 'admin', permissions: ['*'] }
    , { name: 'denied', permissions: [ ] }
    , { name: 'status-only', permissions: [ 'api:status:read' ] }
    , { name: 'readable', permissions: [ '*:*:read' ] }
    , { name: 'careportal', permissions: [ 'api:treatments:create' ] }
    , { name: 'devicestatus-upload', permissions: [ 'api:devicestatus:create' ] }
    , { name: 'activity', permissions: [ 'api:activity:create' ] }
  ];

  storage.ensureIndexes = function ensureIndexes() {
    ctx.store.ensureIndexes(rolesCollection, ['name']);
    ctx.store.ensureIndexes(subjectsCollection, ['name']);
  }

  storage.getSHA1 = function getSHA1 (message) {
    var shasum = crypto.createHash('sha1');
    shasum.update(message);
    return shasum.digest('hex');
  }

  storage.reload = function reload (callback) {

    console.log('Reloading auth data');

    storage.listRoles({sort: {name: 1}}, function listResults (err, results) {

      console.log('Roles listed');

      if (err) {
        console.log('Problem listing roles', err);
        return callback && callback(err);
      }

      storage.roles = results || [ ];

      _.forEach(storage.defaultRoles, function eachRole (role) {
        if (_.isEmpty(_.find(storage.roles, {name: role.name}))) {
          storage.roles.push(role);
        }
      });

      storage.roles = _.sortBy(storage.roles, 'name');

      storage.listSubjects({sort: {name: 1}}, function listResults (err, results) {
        if (err) {
          console.log('Problem listing subjects', err);
          return callback && callback(err);
        }

        storage.subjects = _.map(results, function eachSubject (subject) {
          if (env.enclave.isApiKeySet()) {
            subject.digest = env.enclave.getSubjectHash(subject._id.toString());
            var abbrev = subject.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
            subject.accessToken = abbrev + '-' + subject.digest.substring(0, 16);
            subject.accessTokenDigest = storage.getSHA1(subject.accessToken);
          }

          return subject;
        });

        if (callback) {
          callback( );
        }
      });
    });

  };

  function storageReload () {
    return runWithCallback(function () {
      return new Promise(function (resolve, reject) {
        storage.reload(function loaded(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    });
  }

  storage.findRole = function findRole (roleName) {
    return _.find(storage.roles, {name: roleName});
  };

  storage.roleToShiro = function roleToShiro (roleName) {
    var shiro = null;

    var role = storage.findRole(roleName);
    if (role) {
      shiro = shiroTrie.new();
      shiro.add(role.permissions);
    }

    return shiro;
  };

  storage.rolesToShiros = function roleToShiro (roleNames) {
    return _.chain(roleNames)
      .map(storage.roleToShiro)
      .reject(_.isEmpty)
      .value();
  };

  storage.roleToPermissions = function roleToPermissions (roleName) {
    var permissions = [ ];

    var role = storage.findRole(roleName);
    if (role) {
      permissions = role.permissions;
    }

    return permissions;
  };

  storage.findSubject = function findSubject (accessToken) {

    if (!accessToken) return null;

    function checkToken(accessToken) {
      var split_token = accessToken.split('-');
      var prefix = split_token ? _.last(split_token) : '';

      if (prefix.length < 16) {
        return null;
      }

      return _.find(storage.subjects, function matches (subject) {
        return subject.accessTokenDigest.indexOf(accessToken) === 0 || subject.digest.indexOf(prefix) === 0;
      });
   }

   if (!Array.isArray(accessToken)) accessToken = [accessToken];

   for (let i=0; i < accessToken.length; i++) {
     const subject = checkToken(accessToken[i]);
     if (subject) return subject;
   }

   return null;
  };

  storage.doesAccessTokenExist = function doesAccessTokenExist(accessToken) {
    if (storage.findSubject(accessToken)) {
      return true;
    }
    return false;
  }

  storage.resolveSubjectAndPermissions = function resolveSubjectAndPermissions (accessToken) {
    var shiros = [];

    var subject = storage.findSubject(accessToken);
    if (subject) {
      shiros = storage.rolesToShiros(subject.roles);
    }

    return {
      subject: subject
      , shiros: shiros
    };
  };

  return storage;

}

module.exports = init;
