'use strict';

var express = require('express');

/**
 * @typedef {object} NightscoutEnv
 * @property {object} settings
 * @property {function(object): object} settings.filteredSettings - Function to filter settings.
 */

/**
 * @typedef {object} NightscoutAuthorization
 * @property {function(string): function} isPermitted - Function to check permissions.
 */

/**
 * @typedef {object} NightscoutSbx
 * @property {object} [properties] - Properties from sandbox.
 */

/**
 * @typedef {object} NightscoutContext
 * @property {NightscoutAuthorization} authorization - Authorization module.
 * @property {NightscoutSbx} [sbx] - Sandbox object.
 */

/**
 * Creates an Express router for handling properties API requests.
 * @param {NightscoutEnv} env - The environment configuration.
 * @param {NightscoutContext} ctx - The application context.
 * @returns {express.Router} An Express router.
 */
function create (env, ctx) {
  var properties = express( );

  /**
   * Supports the paths:
   * /v2/properties - All properties
   * /v2/properties/prop1 - Only prop1
   * /v2/properties/prop1,prop3 - Only prop1 and prop3
   *
   * Expecting to define extended syntax and support for several query params
   */
  properties.use(ctx.authorization.isPermitted('api:entries:read'),
    ctx.authorization.isPermitted('api:treatments:read'));
  /**
   * @param {express.Request} req
   * @param {express.Response} res
   */
  properties.get(['/', '/*'], function getProperties (req, res) {

    if (!ctx.sbx) {
      return res.json({});
    }

    /**
     * Checks if a string part is not empty.
     * @param {string} part - The string part to check.
     * @returns {boolean} True if the part is not an empty string, false otherwise.
     */
    function notEmpty (part) {
      return part !== '';
    }

    var segments = req.path.split('/').filter(notEmpty);

    /** @type {string[]} */
    var selected = [ ];

    if (segments.length > 0) {
      selected = segments[0].split(',').filter(notEmpty);
    }

    /** @type {object} */
    var result = ctx.sbx.properties || {};

    if (selected.length > 0) {
      result = selected.reduce((obj, key) => {
        if (ctx.sbx && ctx.sbx.properties && Object.prototype.hasOwnProperty.call(ctx.sbx.properties, key)) {
          obj[key] = ctx.sbx.properties[key];
        }
        return obj;
      }, {});
    }

    result = env.settings.filteredSettings(result);
    
    if (req.query && req.query.pretty) {
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(result, null, 2));
    } else {
      res.json(result);
    }

  });


  return properties;
}

module.exports = create;
