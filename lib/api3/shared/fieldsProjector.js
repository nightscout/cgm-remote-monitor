'use strict';

const _each = require('lodash/each');

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
      _each(specific, function include (field) {
        projection[field] = 1;
      });

      _each(systemFields, function include (field) {
        projection[field] = 1;
      });
    }
    else {
      _each(exclude, function exclude (field) {
        projection[field] = 0;
      });

      _each(exclude, function exclude (field) {
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
      for(const field in doc) {
        if (specific.indexOf(field) === -1) {
          delete doc[field];
        }
      }
    }
    else {
      _each(exclude, function include (field) {
        if (typeof(doc[field]) !== 'undefined') {
          delete doc[field];
        }
      });
    }
  };
}

module.exports = FieldsProjector;