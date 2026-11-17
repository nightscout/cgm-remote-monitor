'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const levels = require('../lib/levels');
const createNotifications = require('../lib/notifications');

describe('Notification service state ownership', function () {
  const services = [];
  function service() {
    const bus = new EventEmitter();
    const events = [];
    bus.on('notification', notify => events.push(notify));
    const notifications = createNotifications({testMode: true}, {
      bus, levels, ddata: {lastUpdated: Date.now() + 1}
    });
    const instance = {bus, events, notifications};
    services.push(instance);
    return instance;
  }
  function request(group) {
    return {level: levels.WARN, group, title: 'Fixture', message: 'Fixture message', plugin: {name: 'fixture'}};
  }
  afterEach(function () {
    for (const item of services.splice(0)) {
      item.bus.emit('teardown');
      item.notifications.resetStateForTests();
    }
  });

  it('does not carry one service snooze into another service over repeated lifecycles', function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      const first = service(), second = service();
      const group = 'isolation-' + cycle;
      first.notifications.ack(levels.WARN, group, 600000);
      first.notifications.requestNotify(request(group));
      first.notifications.process();
      assert.equal(first.events.length, 0, 'The first service remains snoozed');
      second.notifications.requestNotify(request(group));
      second.notifications.process();
      assert.equal(second.events.filter(event => event.level === levels.WARN).length, 1,
        'An independent service must not inherit the snooze');
      first.bus.emit('teardown');
      second.bus.emit('teardown');
    }
  });

  it('clears pending requests and ignores requests and acknowledgements after teardown', function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      const instance = service();
      const notify = request('closed-' + cycle);
      instance.notifications.requestNotify(notify);
      instance.notifications.requestSnooze({...notify, lengthMills: 600000});
      assert.equal(instance.notifications.findHighestAlarm(notify.group), notify);
      instance.bus.emit('teardown');
      instance.bus.emit('teardown');
      assert.equal(instance.notifications.findHighestAlarm(notify.group), undefined);
      assert.equal(instance.notifications.snoozedBy(notify), false);
      instance.notifications.requestNotify(notify);
      instance.notifications.requestSnooze({...notify, lengthMills: 600000});
      instance.notifications.process();
      instance.notifications.ack(levels.URGENT, notify.group, 600000, true);
      assert.equal(instance.notifications.findHighestAlarm(notify.group), undefined);
      assert.equal(instance.notifications.snoozedBy(notify), false);
      assert.deepEqual(instance.events, []);
      assert.equal(instance.bus.listenerCount('teardown'), 0);
    }
  });
});
