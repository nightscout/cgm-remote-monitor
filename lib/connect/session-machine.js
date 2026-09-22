'use strict';

const { createMachine, interpret } = require('xstate');

module.exports = () => interpret(createMachine({
  id: 'carelink-login', predictableActionArguments: true, initial: 'starting',
  on: { CANCEL: '.cancelled', EXPIRE: '.expired', FAIL: '.failed' },
  states: {
    starting: { on: { READY: 'waiting', CALLBACK: 'exchanging' } },
    waiting: { on: { CALLBACK: 'exchanging' } },
    exchanging: { on: { SELECT: 'selecting' } },
    selecting: { on: { SAVE: 'saving' } },
    saving: { on: { DONE: 'connected' } },
    connected: { type: 'final' }, cancelled: { type: 'final' }, expired: { type: 'final' }, failed: { type: 'final' }
  }
})).start();
