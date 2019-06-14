  'use strict';

const apiConst = require('../const.json');

/**
  * DELETE: Deletes a document from the collection
  */
function DeleteOperation (ctx, env, app, col) {

  const self = this;
  self.col = col;

  self.operation = function operation (req, res) {
    
    async function deletePermanently () {
      try {
        const result = await col.storage.deleteOne(req.params.identifier);

        if (!result) 
          throw 'empty result';

        if (!result.deleted) {
          return res.status(apiConst.HTTP.NOT_FOUND).end();
        }

        col.autoPrune();
        ctx.bus.emit('data-received');
        return res.status(apiConst.HTTP.NO_CONTENT).end();

      } catch(err)  {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    async function markAsDeleted () {
      try {
        const setFields = { 'isValid': false, 'srvModified': (new Date).getTime() };

        const result = await col.storage.updateOne(req.params.identifier, setFields);

        if (!result) 
          throw 'empty result';

        if (!result.updated) {
          return res.status(apiConst.HTTP.NOT_FOUND).end();
        }

        col.autoPrune();
        ctx.bus.emit('data-received');
        return res.status(apiConst.HTTP.NO_CONTENT).end();

      } catch(err)  {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    col.authorizers.delete(req, res, function authorized () {

      if (req.query.permanent && req.query.permanent === "true") {
        deletePermanently();
      }
      else {
        markAsDeleted();
      }
    });
  }
}

module.exports = DeleteOperation;