'use strict';

var crypto = require('node:crypto');
var shiroTrie = require('shiro-trie');
var ObjectID = require('mongodb').ObjectId;
var idForms = require('../server/object-id-forms');
var runWithCallback = require('../storage/run-with-callback');

var find_options = require('../server/query');
var countParam = require('../server/count');

function init (env, ctx) {
  var utils = require('../utils')(ctx)
  var storage = { };
  // Initialize storage.roles as an empty array
  storage.roles = [];
  storage.subjects = [];

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

  // The fields a stored document owns.
  //
  // A subject's accessToken, accessTokenDigest and digest are not in this list
  // on purpose. reload() derives all three from the subject's _id, its name and
  // the enclave key, and they have to stay derived: a database that does not
  // contain the token is a database an attacker cannot mint one from. Writing
  // whatever the request body contained put the token on disk, because
  // GET /subjects serves it to the admin UI and the edit dialog sends the whole
  // object back.
  var SUBJECT_FIELDS = ['name', 'roles', 'notes', 'created_at'];
  var ROLE_FIELDS = ['name', 'permissions', 'notes', 'created_at'];

  // A subject's derived fields, which reload() recomputes on every load. Listed
  // here so a document that already has them stored -- written by a version of
  // this file that replaced the document wholesale -- cannot supply them.
  var DERIVED_SUBJECT_FIELDS = ['accessToken', 'accessTokenDigest', 'digest'];

  function ownedFields (obj, fields) {
    var doc = { };
    fields.forEach(function eachField (field) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, field)) {
        doc[field] = obj[field];
      }
    });
    return doc;
  }

  // A save replaces the whole stored document, so a field the request did not
  // carry would be dropped. For notes and created_at, leaving a field out
  // means "unchanged", not "remove it": the admin page does not fetch a
  // subject's created_at and never sends it, and a tool that only changes a
  // subject's roles has no reason to send either one. A caller who wants the
  // notes gone sends notes: '' and gets that.
  //
  // This is deliberately not every owned field. The admin page form-encodes
  // its request, and form encoding leaves an empty list out entirely, so the
  // request that removes a subject's last role (or a role's last permission)
  // carries no roles field at all. Filling roles or permissions in from the
  // stored document would quietly keep access the operator had just removed.
  function keepStoredFields (collection, doc) {
    var keepNotes = !Object.prototype.hasOwnProperty.call(doc, 'notes');
    var keepCreatedAt = !doc.created_at;
    if (!keepNotes && !keepCreatedAt) {
      return Promise.resolve();
    }

    return collection.findOne({ _id: doc._id }, { projection: { notes: 1, created_at: 1 } })
      .then(function merge (stored) {
        if (!stored) { return; }
        if (keepNotes && Object.prototype.hasOwnProperty.call(stored, 'notes')) {
          doc.notes = stored.notes;
        }
        if (keepCreatedAt && stored.created_at) {
          doc.created_at = stored.created_at;
        }
      });
  }

  function create (collection, fields) {
    function doCreate(obj, fn) {
      var doc = ownedFields(obj, fields);

      if (!Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.created_at = (new Date()).toISOString();
      }

      // A 24-hex _id is stored as the ObjectId it names, as save stores it.
      if (idForms.isHexId(obj._id)) {
        obj._id = idForms.toStoredId(obj._id);
      }

      return runWithCallback(async function () {
        try {
          await collection.insertOne(doc);
        } catch (err) {
          if (err != null && err.message) {
            console.log('Data insertion error', err.message);
            throw err.message;
          }
          throw err;
        }

        await storageReload();
        return doc;
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
        return countParam.applyCount(this, opts);
      }

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
        // Either form: create stored a hex _id as the string up to 15.0.8.
        await collection.deleteMany({ '_id': idForms.idFilter(_id) });
        await storageReload();
        return null;
      }, callback);
    }
    return doRemove;
  }

  function save (collection, fields) {
    function doSave (obj, callback) {
      var idResult = normalizeRequiredObjectId(obj && obj._id);
      if (idResult.error) {
        callback(idResult.error, null);
        return;
      }

      var doc = ownedFields(obj, fields);

      doc._id = idResult.value;

      return runWithCallback(async function () {
        await keepStoredFields(collection, doc);
        if (!doc.created_at) {
          doc.created_at = (new Date()).toISOString();
        }
        await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
        await storageReload();
        return doc;
      }, callback);
    }
    return doSave;
  }

  storage.createSubject = create(subjectsCollection, SUBJECT_FIELDS);
  storage.saveSubject = save(subjectsCollection, SUBJECT_FIELDS);
  storage.removeSubject = remove(subjectsCollection);
  storage.listSubjects = list(subjectsCollection);

  storage.createRole = create(rolesCollection, ROLE_FIELDS);
  storage.saveRole = save(rolesCollection, ROLE_FIELDS);
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
      storage.roles = results || [];
      storage.defaultRoles.forEach(function eachRole (role) {
        if (!storage.roles.find(r => r.name === role.name)) {
          storage.roles.push(role);
        }
      });

      storage.roles = storage.roles.sort((a, b) => a.name.localeCompare(b.name));

      storage.listSubjects({sort: {name: 1}}, function listResults (err, results) {
        if (err) {
          console.log('Problem listing subjects', err);
          return callback && callback(err);
        }
        storage.subjects = results.map(function eachSubject (subject) {
          // Drop anything a stored document is carrying under a derived name
          // before deriving it, so a row written before these fields were kept
          // out of the collection cannot supply one of them.
          DERIVED_SUBJECT_FIELDS.forEach(function eachField (field) {
            delete subject[field];
          });

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
    // Make sure storage.roles exists
    if (!storage.roles || !Array.isArray(storage.roles)) {
      storage.roles = storage.defaultRoles || [];
    }

    const role = storage.roles.find(role => role.name === roleName);
    return role;
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
    // Check if roleNames is undefined or null
    if (!roleNames || !Array.isArray(roleNames)) {
      return [];
    }

    // Make sure storage.roles exists
    if (!storage.roles || !Array.isArray(storage.roles)) {
      storage.roles = storage.defaultRoles || [];
    }

    const result = roleNames
      .map(storage.roleToShiro)
      .filter(item => !utils.isEmpty(item));

    return result;
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

    /**
     * Checks if the access token is valid
     * @param {string} accessToken - The access token to check
     * @returns {Object|null} - The subject if found, otherwise null
     */
    function checkToken(accessToken) {
      var split_token = accessToken.split('-');
      var prefix = split_token?.[split_token?.length - 1] || '';

      if (prefix.length < 16) {
        return null;
      }
      return storage.subjects && Array.isArray(storage.subjects) ?
        storage.subjects.find(function matches (subject) {
          return subject && (subject.accessTokenDigest.indexOf(accessToken) === 0 || subject.digest.indexOf(prefix) === 0);
        }) : null;
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
