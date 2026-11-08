'use strict';

const { credential } = require('./http');
const fail = () => Object.assign(new Error('HUMAN_SESSION_REFUSED'), { code: 'HUMAN_SESSION_REFUSED' });

// Socket.IO's browser handshake supplies Origin. Cookie-authenticated streams
// require it; the shared HTTP boundary checks it against the configured origin.
// Direct-token headless sockets retain the Origin-less bearer contract.
function select (ctx, socket, message = {}, names = ['secret', 'token']) {
  if (!ctx.humanSessions) return null;
  const request = socket.request;
  const handshake = credential(request);
  const supplied = names.filter(name => message[name] !== undefined && message[name] !== null && message[name] !== '');
  const human = supplied.filter(name => typeof message[name] === 'string' && message[name].startsWith('nsh_'));
  if (human.length > 1 || human.length && supplied.length > 1 || handshake?.token.startsWith('nsh_') && supplied.some(name => message[name] !== handshake.token)) throw fail();
  const token = human.length ? message[human[0]] : handshake?.token.startsWith('nsh_') ? handshake.token : null;
  if (!token) return null;
  if (handshake && handshake.token !== token) throw fail();
  if (handshake?.cookie && typeof request.headers.origin !== 'string') throw fail();
  return Object.freeze({ token, cookie: !!handshake?.cookie });
}

async function current (ctx, socket, selected) {
  if (!selected) throw fail();
  const original = socket.request;
  let request = original;
  if (!selected.cookie) {
    const headers = { ...original.headers, authorization: 'Bearer ' + selected.token };
    delete headers.cookie;
    request = { ...original, method: 'GET', headers,
      rawHeaders: [...(original.rawHeaders || []).reduce((pairs, value, index, all) => {
        if (index % 2 === 0 && !['authorization', 'cookie'].includes(value.toLowerCase())) pairs.push(value, all[index + 1]);
        return pairs;
      }, []), 'Authorization', 'Bearer ' + selected.token] };
  }
  const { actor } = await ctx.humanSessions.authenticate({ tenant: 'single', credential: selected.token,
    request, purpose: 'data', activity: false });
  return Object.freeze({ actor, read: actor.allows('api:*:read'),
    write: actor.allows('api:*:create,update,delete'),
    write_treatment: actor.allows('api:treatments:create,update,delete'), ack: actor.allows('notifications:*:ack') });
}

module.exports = { select, current };
