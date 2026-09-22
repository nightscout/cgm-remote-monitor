'use strict';

const EventEmitter = require('node:events');
class Protocol extends EventEmitter {
  constructor(child) {
    super(); this.child = child; this.next = 0; this.pending = new Map(); this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) return this.close();
      let end;
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(raw); } catch (_) { continue; }
        if (message.id && this.pending.has(message.id)) {
          const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timer);
          if (message.error) p.reject(new Error('browser_protocol')); else p.resolve(message.result);
        } else this.emit('event', message);
      }
    });
    child.stdio[3].on('error', () => this.close());
    child.stdio[4].on('error', () => this.close());
    child.on('exit', () => this.close());
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('browser_closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('browser_timeout')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('browser_closed')); }
    this.pending.clear(); this.buffer = ''; this.emit('closed');
  }
}
module.exports = Protocol;
