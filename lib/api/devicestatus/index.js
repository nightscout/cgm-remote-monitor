'use strict';

const consts = require('../../constants');
const moment = require('moment');
const objectIdValidation = require('../shared/objectid-validation');
const normalizeDeleteStatus = require('../shared/delete-status');

/**
 * @typedef {import('express').Application} ExpressApp
 * @typedef {import('express').Request} ExpressRequest
 * @typedef {import('express').Response} ExpressResponse
 * @typedef {import('express').NextFunction} ExpressNextFunction
 * @typedef {Object} Wares An object containing middleware functions.
 * @property {function} sendJSONStatus Middleware to send JSON status.
 * @property {function} rawParser Middleware for raw body parsing.
 * @property {function} jsonParser Middleware for JSON body parsing.
 * @property {function} urlencodedParser Middleware for URL-encoded body parsing.
 * @typedef {Object} Ctx The application context.
 * @property {any} authorization Authorization module.
 * @property {{ devicestatus?: Array<any> }} cache Cache module.
 * @property {{ list: (query: any, cb: (err: Error | null, results: Array<any> | null) => void) => void, create: (data: any, cb: (err: Error | null, created: any) => void) => void, remove: (query: any, cb: (err: Error | null, stat: any) => void) => void }} devicestatus Devicestatus data module.
 * @property {{ purifyObject: (obj: any) => void }} purifier Purifier module.
 * @typedef {Object} Env The environment configuration.
 * @property {{ deNormalizeDates?: boolean }} settings Application settings.
 */

/**
 * Configures the devicestatus API routes.
 * @param {ExpressApp} app The Express application.
 * @param {Wares} wares An object containing middleware functions.
 * @param {Ctx} ctx The application context.
 * @param {Env} env The environment configuration.
 * @returns {import('express').Router} The configured Express router.
 */
function configure (app, wares, ctx, env) {
  var express = require('express')
    , api = express.Router();

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  api.use(wares.rawParser);
  api.use(wares.jsonParser);
  api.use(wares.urlencodedParser);

  api.use(ctx.authorization.isPermitted('api:devicestatus:read'));

  /**
   * Processes dates in results for de-normalization if configured.
   * @param {Array<Object> | null | undefined} results The array of results to process.
   * @returns {Array<Object>} The processed results.
   */
  function processDates(results) {
    if (!Array.isArray(results)) {
        return []; // Return empty array if results is not an array
    }
    // Support date de-normalization for older clients
    if (env.settings.deNormalizeDates) {
      const r = [];
      results.forEach(function(e) {
        if (e && e.created_at && Object.prototype.hasOwnProperty.call(e, 'utcOffset')) {
          const d = moment(e.created_at).utcOffset(e.utcOffset);
          e.created_at = d.toISOString(true);
          delete e.utcOffset;
        }
        r.push(e);
      });
      return r;
    } else {
      return results;
    }
  }

  // List settings available
  /**
   * @param {ExpressRequest} req
   * @param {ExpressResponse} res
   */
  api.get('/devicestatus/', function(req, res) {
    /** @type {Object<string, any>} */
    const queryParams = req.query;

    /** @type {number} */
    let numCount;
    if (typeof queryParams.count === 'string') {
        numCount = parseInt(queryParams.count, 10);
        if (isNaN(numCount) || numCount <= 0) {
            numCount = 10; // Default for invalid string count
        }
    } else if (typeof queryParams.count === 'number' && queryParams.count > 0) {
        numCount = queryParams.count; // Use if already a valid number
    } else {
        numCount = 10; // Default if not present or invalid type
    }

    const inMemoryData = ctx.cache.devicestatus ? ctx.cache.devicestatus : [];

    // Determine if the query is simple enough to be served from cache.
    // A query is simple if it's empty or only contains the 'count' parameter.
    // Any 'find' or other filtering parameters mean it should not be served from cache.
    let isSimpleQuery = true;
    for (const key in queryParams) {
        if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
            if (key !== 'count') {
                isSimpleQuery = false;
                break;
            }
        }
    }

    const canServeFromMemory = isSimpleQuery && inMemoryData.length >= numCount;

    if (canServeFromMemory) {
      // Sort a copy of the array to avoid modifying the cache directly
      const sorted = [...inMemoryData].sort((a, b) => (b.mills || 0) - (a.mills || 0));
      return res.json(processDates(sorted.slice(0, numCount)));
    }

    // If not serving from memory, prepare the query for the database.
    // Ensure the 'count' parameter passed to the DB layer is the numeric one.
    /** @type {Object<string, any>} */
    const dbQuery = { ...queryParams };
    dbQuery.count = numCount; // Use the parsed and validated numeric count

    ctx.devicestatus.list(dbQuery, function(err, results) {
      if (err) {
        console.error("API Error: Failed to list devicestatus entries.", err);
        return res.status(500).json(processDates([]));
      }
      // Ensure results is an array before passing to processDates
      return res.json(processDates(results || []));
    });
  });

  /**
   * @param {ExpressApp} app_authed
   * @param {import('express').Router} api_authed
   * @param {Wares} wares_authed
   * @param {Ctx} ctx_authed
   */
  function config_authed (app_authed, api_authed, wares_authed, ctx_authed) {

    /**
     * @param {ExpressRequest} req
     * @param {ExpressResponse} res
     */
    function doPost (req, res) {
      var statuses = req.body;

      // Normalize to array (NightscoutKit sends arrays)
      if (!Array.isArray(statuses)) {
        statuses = [statuses];
      }

      // Validate _id fields before storage (return 400 on invalid)
      var invalid = objectIdValidation.findInvalidId(statuses);
      if (invalid) {
        return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
          'Invalid _id format', 'Must be 24-character hex string or omit for auto-generation. Got: ' + String(invalid.id));
      }

      // Purify each devicestatus object
      for (var i = 0; i < statuses.length; i++) {
        ctx_authed.purifier.purifyObject(statuses[i]);
      }

      ctx_authed.devicestatus.create(statuses, function(err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          res.json(created);
        }
      });
    }

    api_authed.post('/devicestatus/', ctx_authed.authorization.isPermitted('api:devicestatus:create'), doPost);

    /**
     * Delete devicestatus. The query logic works the same way as find/list.
     * This endpoint uses same search logic to remove records from the database.
     * @param {ExpressRequest} req
     * @param {ExpressResponse} res
     * @param {ExpressNextFunction} next
     */
    function delete_records (req, res, next) {
      /** @type {Object<string, any>} */
      var query = req.query;
      // Ensure count is a number if present, or default.
      // For delete operations, 'count' might not be typical unless it means "limit number of docs to delete".
      // The original code defaults it to 10 if not present.
      if (query.count) {
        const parsedCount = parseInt(String(query.count), 10);
        if (!isNaN(parsedCount) && parsedCount > 0) {
          query.count = parsedCount;
        } else {
          query.count = 10;
        }
      } else {
        query.count = 10; // Default if not provided
      }

      console.log('Delete records with query: ', query);

      // remove using the query
      ctx_authed.devicestatus.remove(query, function(err, stat) {
        if (err) {
          console.log('devicestatus delete error: ', err);
          return next(err);
        }
        // yield some information about success of operation
        res.json(normalizeDeleteStatus(stat));

        console.log('devicestatus records deleted');

        return next();
      });
    }

    api_authed.delete('/devicestatus/:id', ctx_authed.authorization.isPermitted('api:devicestatus:delete'), function(req, res, next) {
      // Validate _id parameter (unless wildcard)
      if (req.params.id !== '*' && !objectIdValidation.isValidObjectId(req.params.id)) {
        return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
          'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(req.params.id));
      }

      if (!req.query.find) {
        req.query.find = {
          _id: req.params.id
        };
      } else {
        req.query.find._id = req.params.id;
      }

      if (req.query.find._id === '*') {
        delete req.query.find._id;
      }
      next();
    }, delete_records);

    api_authed.delete('/devicestatus/', ctx_authed.authorization.isPermitted('api:devicestatus:delete'), delete_records);
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;
