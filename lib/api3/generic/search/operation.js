'use strict';

const apiConst = require('../../const.json')
  , input = require('./input')
  , _each = require('lodash/each')
  , FieldsProjector = require('../../shared/fieldsProjector')


/**
  * SEARCH: Search documents from the collection
  */
function SearchOperation (ctx, env, app, col) {

  const self = this;

  self.col = col;

  self.operation = function operation (req, res) {

    async function loadFromDb () {

      try {
        const fieldsProjector = new FieldsProjector(req.query.fields);

        const filter = input.parseFilter(req, res)
          , sort = input.parseSort(req, res)
          , limit = col.parseLimit(req, res)
          , skip = input.parseSkip(req, res)
          , projection = fieldsProjector.storageProjection()
          , onlyValid = true


        if (filter !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

          const result = await col.storage.findMany(filter
            , sort
            , limit
            , skip
            , projection
            , onlyValid);

          if (!result) 
            throw new Error('empty result');

          _each(result, col.resolveDates);

          _each(result, fieldsProjector.applyProjection);

          res.status(apiConst.HTTP.OK).send(result);
        }
      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }

    if (col.colName === 'settings') {
      col.authorizers.admin(req, res, loadFromDb);  // listing of settings needs special permission
    } else {
      col.authorizers.read(req, res, loadFromDb);
    }
  }
}

module.exports = SearchOperation;