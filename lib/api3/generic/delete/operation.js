  'use strict';

const apiConst = require('../../const.json');

/**
  * DELETE: Deletes a document from the collection
  */
function DeleteOperation (ctx, env, app, col) {

  const self = this;
  self.col = col;

  self.operation = function operation (req, res) {
    
    async function deletePermanently () {
      try {
        const identifier = req.params.identifier;
        const result = await col.storage.deleteOne(identifier);

        if (!result) 
          throw new Error('empty result');

        if (!result.deleted) {
          return res.status(apiConst.HTTP.NOT_FOUND).end();
        }

        col.autoPrune();
        ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
        ctx.bus.emit('data-received');
        return res.status(apiConst.HTTP.NO_CONTENT).end();

      } catch(err)  {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    async function markAsDeleted (authorization) {
      try {
        const identifier = req.params.identifier;
        const setFields = { 'isValid': false, 'srvModified': (new Date).getTime() };

        if (authorization && authorization.subject && authorization.subject.name) {
          setFields.modifiedBy = authorization.subject.name;
        }

        const result = await col.storage.updateOne(identifier, setFields);

        if (!result) 
          throw new Error('empty result');

        if (!result.updated) {
          return res.status(apiConst.HTTP.NOT_FOUND).end();
        }

        ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
        col.autoPrune();
        ctx.bus.emit('data-received');
        return res.status(apiConst.HTTP.NO_CONTENT).end();

      } catch(err)  {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    col.authorizers.delete(req, res, function authorized (authorization) {

      if (req.query.permanent && req.query.permanent === "true") {
        deletePermanently();
      }
      else {
        markAsDeleted(authorization);
      }
    });
  }
}

module.exports = DeleteOperation;