'use strict';

var _ = require('lodash');

function cache (env, ctx) {

  const data = {
    treatments : [],
    devicestatus : [],
    sgvs : [],
    cals : [],
    mbgs : []
  };

  const dataArray = [
    data.treatments,
    data.devicestatus,
    data.sgvs,
    data.cals,
    data.mbgs
  ];

  function match(o1, o2) {
    return o1._id == o2._id;
  }

  function dataChanged(operation) {
    console.log('Cache data update event', data);

    if (operation.op == 'remove') {
      console.log('Cache data delete event');
      // if multiple items were deleted, flush entire cache
      if (!operation.changes) {
        console.log('Multiple items delete from cache, flushing all')
        data[operation.op.type] = [];
      } else {
        removeFromArray(data[operation.type], operation.changes);
      }
    }

    if (operation.op == 'update') {
      console.log('Cache data update event');
    } 
  }

  ctx.bus.on('data-update', dataChanged);

  function removeFromArray(array, id) {
    for (let i = 0; i < array.length; i++) {
      const o = array[i];
      if (o._id == id) {
        console.log('Deleting object from cache', id);
        array.splice(i,1);
        break;
      }
    }
  }

  cache.updateObject = (o) => {

  }

  return data;
  
}

module.exports = cache;
