
'use strict';

var adminnotifies = {};

function init(ctx) {

    adminnotifies.notifies = [];

    adminnotifies.addNotify = function addnotify(notify) {
        adminnotifies.notifies.push(notify);
    }

    adminnotifies.getNotifies = function getNotifies() {
        return adminnotifies.notifies;
    }

    return adminnotifies;
}

module.exports = init;
