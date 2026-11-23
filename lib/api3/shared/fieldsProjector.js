'use strict';

/**
 * Cut everything out of a value that no requested field names.
 * A requested field either names a key outright, in which case the whole value
 * under it is kept, or names a path below it, in which case only that path is.
 * @param {any} value
 * @param {Array<string>} fields - paths wanted, relative to value
 */
function pruneToFields (value, fields) {

  if (Array.isArray(value)) {
    value.forEach(item => pruneToFields(item, fields));
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const key of Object.keys(value)) {
    if (fields.includes(key)) {
      continue;
    }

    const prefix = key + '.'
      , subFields = fields
        .filter(field => field.startsWith(prefix))
        .map(field => field.substring(prefix.length));

    if (subFields.length === 0
      || value[key] === null
      || typeof value[key] !== 'object') {
      delete value[key];
      continue;
    }

    pruneToFields(value[key], subFields);
  }
}


/**
  * Decoder of 'fields' parameter providing storage projections
  * @param {string} fieldsString - fields parameter from user
  */
function FieldsProjector (fieldsString) {

  const self = this
    , exclude = [];
  let specific = null;

  switch (fieldsString)
  {
    case '_all':
      break;

    default:
      if (fieldsString) {
        specific = fieldsString.split(',');
      }
  }

  const systemFields = ['identifier', 'srvCreated', 'created_at', 'date'];

  /**
   * Prepare projection definition for storage query
   * */
  self.storageProjection = function storageProjection () {
    const projection = { };
    if (specific) {
      specific.forEach(function include (field) {
        projection[field] = 1;
      });

      systemFields.forEach(function include (field) {
        projection[field] = 1;
      });
    }
    else {
      exclude.forEach(function exclude (field) {
        projection[field] = 0;
      });

      exclude.forEach(function exclude (field) {
        if (systemFields.indexOf(field) >= 0) {
          delete projection[field];
        }
      });
    }

    return projection;
  };


  /**
   * Cut off unwanted fields from given document
   * @param {Object} doc
   */
  self.applyProjection = function applyProjection (doc) {

    if (specific) {
      pruneToFields(doc, specific);
    }
    else {
      exclude.forEach(function include (field) {
        if (typeof(doc[field]) !== 'undefined') {
          delete doc[field];
        }
      });
    }
  };
}

module.exports = FieldsProjector;