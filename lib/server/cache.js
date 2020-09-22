'use strict';

/* This is a simple cache intended to reduce the amount of load
 * Nightscout puts on MongoDB. The cache is based on identifying
 * elements based on the MongoDB _id field and implements simple
 * semantics for adding data to the cache in the runtime, intended
 * to be accessed by the persistence layer as data is inserted, updated
 * or deleted, as well as the periodic dataloader, which polls Mongo
 * for new inserts.
 * 
 * Longer term, the cache is planned to allow skipping the Mongo polls
 * altogether.
 */

const _ = require('lodash');
const constants = require('../constants');

function cache (env, ctx) {

  const data = {
    treatments: []
    , devicestatus: []
    , entries: []
  };

  const dataArray = [
    data.treatments
    , data.devicestatus
    , data.entries
  ];


  function mergeCacheArrays (oldData, newData, ageLimit) {

    var filtered = _.filter(newData, function hasId (object) {
      const hasId = !_.isEmpty(object._id);
      const isFresh = (ageLimit && object.mills >= ageLimit) || (!ageLimit);
      return isFresh && hasId;
    });

    const merged = ctx.ddata.idMergePreferNew(oldData, filtered);

    return _.sortBy(merged, function(item) {
      return -item.mills;
    });

  }

  data.isEmpty = (datatype) => {
    return data[datatype].length == 0;
  }

  data.getData = (datatype) => {
    return _.cloneDeep(data[datatype]);
  }

  data.insertData = (datatype, newData, retentionPeriod) => {
    data[datatype] = mergeCacheArrays(data[datatype], newData, retentionPeriod);
  }

  function dataChanged (operation) {
    //console.log('Cache data operation requested', operation);

    if (!data[operation.type]) return;

    if (operation.op == 'remove') {
      //console.log('Cache data delete event');
      // if multiple items were deleted, flush entire cache
      if (!operation.changes) {
        //console.log('Multiple items delete from cache, flushing all')
        data.treatments = [];
        data.devicestatus = [];
        data.entries = [];
      } else {
        removeFromArray(data[operation.type], operation.changes);
      }
    }

    if (operation.op == 'update') {  
      //console.log('Cache data update event');
      data[operation.type] = mergeCacheArrays(data[operation.type], operation.changes);
    }
  }

  ctx.bus.on('data-update', dataChanged);

  function removeFromArray (array, id) {
    for (let i = 0; i < array.length; i++) {
      const o = array[i];
      if (o._id == id) {
        //console.log('Deleting object from cache', id);
        array.splice(i, 1);
        break;
      }
    }
  }

  return data;

}

module.exports = cache;
