'use strict';

const constants = require('../../constants');
const moment = require('moment');
const normalizeDeleteStatus = require('../shared/delete-status');
const sendQueryValidationError = require('../shared/query-error');
const writeValidation = require('../../server/write-validation');
const writeIntent = require('../../storage/write-intent');
const batchReply = require('../shared/batch-reply');
const { recordForLog, debugLogging } = require('../../server/log-privacy');

function configure (app, wares, ctx, env) {
  // DEBUG_LOGGING adds the records to these lines (BF-193).
  const debug = debugLogging(env);
  var express = require('express')
    , api = express.Router();

  api.use(wares.compression());

  // text body types get handled as raw buffer stream
  api.use(wares.rawParser);
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json({
    limit: '50Mb'
  }));
  // also support url-encoded content-type
  api.use(wares.urlencodedParser);

  // invoke common middleware
  api.use(wares.sendJSONStatus);

  api.use(ctx.authorization.isPermitted('api:treatments:read'));

  function serveTreatments(req,res, err, results) {
    if (err) {
      if (sendQueryValidationError(res, err)) return;
      return res.sendJSONStatus(res, constants.HTTP_INTERNAL_ERROR, 'Query Error', err.message || String(err));
    }

    var ifModifiedSince = req.get('If-Modified-Since');

    var d1 = null;

    const deNormalizeDates = env.settings.deNormalizeDates;

    results.forEach(function clean (t) {
      t.carbs = Number(t.carbs);
      t.insulin = Number(t.insulin);

      if (deNormalizeDates && Object.prototype.hasOwnProperty.call(t, 'utcOffset')) {
          const d = moment(t.created_at).utcOffset(t.utcOffset);
          t.created_at = d.toISOString(true);
          delete t.utcOffset;
      }

      var d2 = null;

      if (Object.prototype.hasOwnProperty.call(t, 'created_at')) {
        d2 = new Date(t.created_at);
      } else {
        if (Object.prototype.hasOwnProperty.call(t, 'timestamp')) {
          d2 = new Date(t.timestamp);
        }
      }

      if (d2 == null) { return; }

      if (d1 == null || d2.getTime() > d1.getTime()) {
        d1 = d2;
      }    });

    if (d1 != null) {
      res.setHeader('Last-Modified', d1.toUTCString());

      if (ifModifiedSince && d1.getTime() <= moment(ifModifiedSince).valueOf()) {
        res.status(304).send({
          status: 304
          , message: 'Not modified'
          , type: 'internal'
        });
        return;
      }
    }

    return res.json(results);
  }

  // List treatments available
  api.get('/treatments', function(req, res) {
    var query = req.query;
    if (!query.count) {
        // If there's a date search involved, default to a higher number of objects
        query.count = query.find ? 1000 : 100;
      }

    const inMemoryData = ctx.cache.treatments;    const canServeFromMemory = inMemoryData && inMemoryData.length >= query.count && Object.keys(query).length == 1 ? true : false;

    if (canServeFromMemory) {
      serveTreatments(req, res, null, inMemoryData.slice(0, query.count));
    } else {
      ctx.treatments.list(query, function(err, results) {
        serveTreatments(req,res,err,results);
      });
    }
  });

  function config_authed (app, api, wares, ctx) {

    function post_response (req, res) {
      var treatments = req.body;

      if (!Array.isArray(treatments)) {
        treatments = [treatments];
      }
      for (let i = 0; i < treatments.length; i++) {
        const t = treatments[i];

        if (!t.created_at) {
          t.created_at = new Date().toISOString();
        }

        ctx.purifier.purifyObject(t);

        /*
        if (!t.created_at) {
          console.log('Trying to create treatment without created_at field', t);
          res.sendJSONStatus(res, constants.HTTP_VALIDATION_ERROR, 'Treatments must contain created_at');
          return;
        }
        const d = moment(t.created_at);
        if (!d.isValid()) {
          console.log('Trying to insert date with invalid created_at', t);
          res.sendJSONStatus(res, constants.HTTP_VALIDATION_ERROR, 'Treatments created_at must be an ISO-8601 date');
          return;
        }
        */

      }

      // ID-BATCH (R1): one slot per submitted item, built by index from the
      // refusals made here and the storage's answer for the items written
      // (lib/api/shared/batch-reply.js).
      const batch = batchReply.plan(treatments, { env: env, optIn: false });
      if (batch.accepted.length === 0 && batch.n > 0) {
        return batchReply.send(res, batchReply.build(batch, [], { optIn: false, noun: 'treatments'
          , defaultWarning: validationWarning }));
      }

      ctx.treatments.create(batch.accepted, function(err, created) {
        if (writeValidation.isValidationError(err)) {
          res.sendJSONStatus(res, constants.HTTP_BAD_REQUEST, err.message);
        } else if (err) {
          console.log('Error adding treatment', err);
          res.sendJSONStatus(res, constants.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          console.log('REST API treatment created', recordForLog(created, { collection: 'treatments', debug: debug }));
          // WRITE_VALIDATION=reject stored the other items of the batch; the
          // refused ones keep their slot (see treatments.create).
          batchReply.send(res, batchReply.build(batch, created || [], { optIn: false, noun: 'treatments'
            , defaultWarning: validationWarning }));
        }
      });
    }

    // The Warning a batch with WRITE_VALIDATION refusals only has carried
    // since 6e842c07; other refusals take batch-reply's wording.
    function validationWarning (refused, submittedCount, slots) {
      const other = slots.some(function (slot) {
        return slot && slot.refused && (slot.refused.rules || []).some(function (r) { return r.rule === 'identifier-format'; });
      });
      if (other) return undefined;
      return '299 - "' + refused + ' of ' + submittedCount
        + ' treatments refused by WRITE_VALIDATION; see the refused member of each"';
    }

    api.post('/treatments/', ctx.authorization.isPermitted('api:treatments:create'), post_response);

    /**
     * @function delete_records
     * Delete treatments.  The query logic works the same way as find/list.  This
     * endpoint uses same search logic to remove records from the database.
     */
    function delete_records (req, res, next) {
      var query = req.query;
      if (!query.count) {
        query.count = 10
      }

      // remove using the query
      ctx.treatments.remove(query, function(err, stat) {
        if (err) {
          if (sendQueryValidationError(res, err)) return;
          console.log('treatments delete error: ', err);
          return next(err);
        }

        // yield some information about success of operation
        res.json(normalizeDeleteStatus(stat));

        return next();
      });
    }

    api.delete('/treatments/:id', ctx.authorization.isPermitted('api:treatments:delete'), function(req, res, next) {
      if (!req.query.find) {
        req.query.find = {
          _id: req.params.id
        };
      } else {
        req.query.find._id = req.params.id;
      }

      if (req.query.find._id === '*') {
        // match any record id
        delete req.query.find._id;
      }
      next();
    }, delete_records);

    // delete record that match query
    api.delete('/treatments/', ctx.authorization.isPermitted('api:treatments:delete'), delete_records);

    // update record
    api.put('/treatments/', ctx.authorization.isPermitted('api:treatments:update'), function(req, res) {
      var data = req.body;
      ctx.purifier.purifyObject(data);
      ctx.treatments.save(data, function(err, created) {
        if (writeValidation.isValidationError(err)) {
          res.sendJSONStatus(res, constants.HTTP_BAD_REQUEST, err.message);
        } else if (writeIntent.isDeletedRecord(err)) {
          // on-deleted (ID-Q3, WRITE_DELETED_EDIT=refuse): nothing was written.
          res.sendJSONStatus(res, constants.HTTP_GONE, err.message);
        } else if (err) {
          res.sendJSONStatus(res, constants.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error saving treatment', err);
        } else {
          res.json(created);
          console.log('Treatment saved', recordForLog(data, { collection: 'treatments', debug: debug }));
        }
      });
    });
  }

  if (app.enabled('api') && app.enabled('careportal')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;
