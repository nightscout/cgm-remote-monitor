'use strict';

const _ = require('lodash');

function init (ctx) {

  const adminnotifies = {};

  adminnotifies.addNotify = function addnotify (notify) {
    if (!notify) return;

    notify.title = notify.title || 'No title';
    notify.message = notify.message || 'No message';

    const existingMessage = _.find(adminnotifies.notifies, function findExisting (obj) {
      return obj.message == notify.message;
    });

    if (existingMessage) {
      existingMessage.count += 1;
      existingMessage.lastRecorded = Date.now();
    } else {
      notify.count = 1;
      notify.lastRecorded = Date.now();
      adminnotifies.notifies.push(notify);
    }
  }

  adminnotifies.getNotifies = function getNotifies () {
    return adminnotifies.notifies;
  }

  ctx.bus.on('admin-notify', adminnotifies.addNotify);

  adminnotifies.clean = function cleanNotifies () {
    adminnotifies.notifies = _.filter(adminnotifies.notifies, function findExisting (obj) {
      return obj.persistent || ((Date.now() - obj.lastRecorded) < 1000 * 60 * 60 * 12);
    });
  }

  adminnotifies.cleanAll = function cleanAll() {
    adminnotifies.notifies = [];
  }

  adminnotifies.cleanAll();

  ctx.bus.on('tick', adminnotifies.clean);

  return adminnotifies;
}

module.exports = init;
