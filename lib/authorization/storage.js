'use strict';

const readContract = require('../storage/read-contract');
const READ_OPTIONS = require('../storage/mongo-read-options');

var crypto = require('node:crypto');
var shiroTrie = require('shiro-trie');
var ObjectID = require('mongodb').ObjectId;
var idForms = require('../server/object-id-forms');
var runWithCallback = require('../storage/run-with-callback');
var writeStep = require('../storage/write-step');
var reads = require('../server/storage-reads');
var writes = require('../server/storage-writes');

function init (env, ctx) {
  var utils = require('../utils')(ctx)
  var storage = { };
  // Initialize storage.roles as an empty array
  storage.roles = [];
  storage.subjects = [];

  // Reads and writes go through the storage interface (lib/server/storage-reads.js,
  // lib/server/storage-writes.js), labelled 'internal': the admin routes and
  // boot write these, not a data API.
  function store (kind) {
    var name = env.authentication_collections_prefix + kind;
    return reads.collection(ctx, env, name, name, { source: 'internal' });
  }
  var rolesCollection = store('roles');
  var subjectsCollection = store('subjects');

  // Index creation is not a write; it takes the driver handle, behind the
  // same boundary.
  function indexHandle (kind) {
    var name = env.authentication_collections_prefix + kind;
    return writeStep.collection(ctx.store.collection(name), { name: name, source: 'internal', bus: ctx.bus });
  }

  function normalizeRequiredObjectId(id) {
    if (id === undefined || id === null || id === '') {
      return { error: 'Missing _id for update' };
    }

    try {
      return { value: new ObjectID(id) };
    } catch {
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

  // reload() derives a subject's access token from its name and sorts the roles
  // by name, so a row whose name is not a string cannot be loaded. A write
  // without a usable name is refused with this error; a row already stored
  // without one is skipped when loading (see loadable()).
  storage.NAME_REQUIRED = 'A name is required';

  function hasUsableName (doc) {
    return typeof doc.name === 'string' && doc.name.trim() !== '';
  }

  function loadable (kind) {
    return function hasStringName (doc) {
      if (doc && typeof doc.name === 'string'
        && (kind !== 'subject' || readContract.identifier(doc._id) !== undefined)) {
        return true;
      }
      console.warn('READ_CONTRACT authorization ' + kind + ': unusable name or identity; record remains stored');
      return false;
    };
  }

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

    return reads.findOne(collection, { _id: doc._id }, { notes: 1, created_at: 1 })
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

      return runWithCallback(async function () {
        if (!hasUsableName(doc)) {
          throw storage.NAME_REQUIRED;
        }

        try {
          await collection.insertOne(doc, { normalize: false });
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

      // Reloads must load complete authorization snapshots, never request filters.

      return runWithCallback(function () {
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'find')) {
          throw new TypeError('Authorization reload lists do not accept filters');
        }
        return reads.list(collection, { }, { sort: sort(), count: opts && opts.count
          , readOptions: READ_OPTIONS });
      }, fn);
    }

    return doList;
  }

  function remove (collection) {
    function doRemove (_id, callback) {
      return runWithCallback(async function () {
        // Either form: up to 15.0.8 create stored a client's 24-hex _id as
        // the string. Create now keeps only the owned fields, so a client
        // _id is not stored at all, but those records remain.
        await writes.remove(collection, { '_id': idForms.idFilter(_id) });
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
        if (!hasUsableName(doc)) {
          throw storage.NAME_REQUIRED;
        }

        await keepStoredFields(collection, doc);
        if (!doc.created_at) {
          doc.created_at = (new Date()).toISOString();
        }
        await writes.replace(collection, { _id: doc._id }, doc, { upsert: true });
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
    // A controller registers with the token it uploads with (registration
    // authority §5); a stored role of the same name replaces this one.
    , { name: 'devicestatus-upload', permissions: [ 'api:devicestatus:create', 'api:registrations:create', 'api:registrations:delete' ] }
    , { name: 'activity', permissions: [ 'api:activity:create' ] }
  ];

  storage.ensureIndexes = function ensureIndexes() {
    return Promise.all([
      ctx.store.ensureIndexes(indexHandle('roles'), ['name'])
      , ctx.store.ensureIndexes(indexHandle('subjects'), ['name'])
    ]);
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
      storage.roles = (results || []).filter(loadable('role'));
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
        storage.subjects = results.filter(loadable('subject')).map(function eachSubject (subject) {
          // Drop anything a stored document is carrying under a derived name
          // before deriving it, so a row written before these fields were kept
          // out of the collection cannot supply one of them.
          DERIVED_SUBJECT_FIELDS.forEach(function eachField (field) {
            delete subject[field];
          });

          if (env.enclave.isApiKeySet()) {
            subject.digest = env.enclave.getSubjectHash(readContract.identifier(subject._id));
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
