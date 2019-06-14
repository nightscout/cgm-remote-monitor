'use strict';

const apiConst = require('../const.json')
  , dateTools = require('../shared/dateTools')
  , FieldsProjector = require('../shared/fieldsProjector')

/**
  * READ: Retrieves a single document from the collection
  */
function ReadOperation (ctx, env, app, col) {

  const self = this;
  self.col = col;

  self.operation = function operation (req, res) {
    
    async function loadFromDb () {
      const fieldsProjector = new FieldsProjector(req.query.fields);

      const result = await col.storage.findOne(req.params.identifier
        , fieldsProjector.storageProjection());

      if (!result) 
        throw 'empty result';

      if (result.length === 0) {
        return res.status(apiConst.HTTP.NOT_FOUND).end();
      }

      const doc = result[0];
      if (doc.isValid === false) {
        return res.status(apiConst.HTTP.GONE).end();
      }

        
      const modifiedDate = col.resolveDates(doc);
      if (modifiedDate) {
        res.setHeader('Last-Modified', modifiedDate.toUTCString())

        const ifModifiedSince = req.get('If-Modified-Since');

        if (ifModifiedSince 
          && dateTools.floorSeconds(modifiedDate) <= dateTools.floorSeconds(new Date(ifModifiedSince))) {
          return res.status(apiConst.HTTP.NOT_MODIFIED).end();
        }
      }

      fieldsProjector.applyProjection(doc);

      res.status(apiConst.HTTP.OK).send(doc);
    }

    col.authorizers.read(req, res, loadFromDb);
  }
}

module.exports = ReadOperation;