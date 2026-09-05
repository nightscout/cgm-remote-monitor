'use strict';

var CACHE = '<%= locals.cachebuster %>';

const PRECACHE_LIST = [
    '/images/launch.png',
    '/images/apple-touch-icon-57x57.png',
    '/images/apple-touch-icon-60x60.png',
    '/images/apple-touch-icon-72x72.png',
    '/images/apple-touch-icon-76x76.png',
    '/images/apple-touch-icon-114x114.png',
    '/images/apple-touch-icon-120x120.png',
    '/images/apple-touch-icon-144x144.png',
    '/images/apple-touch-icon-152x152.png',
    '/images/apple-touch-icon-180x180.png',
    '/images/favicon-32x32.png',
    '/images/android-chrome-192x192.png',
    '/images/favicon-96x96.png',
    '/images/favicon-16x16.png',
    '/manifest.json',
    '/images/favicon.ico',
    '/images/mstile-144x144.png',
    '/css/ui-darkness/jquery-ui.min.css',
    '/css/jquery.tooltips.css',
    '/css/ui-darkness/images/ui-icons_ffffff_256x240.png',
    '/css/ui-darkness/images/ui-icons_cccccc_256x240.png',
    '/css/ui-darkness/images/ui-bg_inset-soft_25_000000_1x100.png',
    '/css/ui-darkness/images/ui-bg_gloss-wave_25_333333_500x100.png',
    '/css/main.css',
    bundleURL('app'),
    bundleURL('clock'),
    '/socket.io/socket.io.js',
    '/js/client.js',
    '/images/logo2.png'
];

// Page code is cached only when visited, never downloaded by dashboard install.
function bundleURL(name) {
  return '/bundle/js/bundle.' + name + '.js?v=' + encodeURIComponent(CACHE);
}
const PAGE_ASSETS = ['reports', 'admin', 'profile', 'food'].map(bundleURL);
const CACHE_LIST = PRECACHE_LIST.concat(PAGE_ASSETS);

// Fulfill the worker event with a network-error response on connection failure.
// Page fetch/script consumers still fail normally, without an unhandled worker rejection.
function network(request) {
  return fetch(request).catch(() => Response.error());
}

async function returnRangeRequest(request) {
  let response;
  try {response = await (await caches.open(CACHE)).match(request.url);}
  catch (error) {console.log('Could not read cached range', error);}
  // A network 206 already contains the requested range; do not slice it again
  // or attempt to store it as a full asset.
  if (!response || response.status !== 200) return network(request);
  const buffer = await response.arrayBuffer();
  const bytes = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range'));
  const start = bytes && Number(bytes[1]);
  const end = bytes && bytes[2] !== '' ? Number(bytes[2]) : buffer.byteLength - 1;
  if (!bytes || start > end || start >= buffer.byteLength) {
    return new Response(null, {status: 416, headers: {'Content-Range': 'bytes */' + buffer.byteLength}});
  }
  const last = Math.min(end, buffer.byteLength - 1);
  return new Response(buffer.slice(start, last + 1), {status: 206, headers: {
    'Content-Range': 'bytes ' + start + '-' + last + '/' + buffer.byteLength,
    'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream'
  }});
}

async function precache() {
  try {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE_LIST.map(async url => {
      const response = await fetch(new Request(url, {cache: 'no-store'}));
      if (response.status === 200) await cache.put(url, response);
    }));
  } catch (error) {console.log('Could not precache assets', error);}
}

async function fromCache(request) {
  let cache;
  try {
    cache = await caches.open(CACHE);
    const matching = await cache.match(request);
    if (matching && matching.status === 200) return matching;
  } catch (error) {console.log('Could not read asset cache', error);}

  const response = await network(request);
  if (cache && response.status === 200) {
    try {await cache.put(request, response.clone());}
    catch (error) {console.log('Could not cache asset', error);}
  }
  return response;
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(precache());
});

function inCache(request) {
  return CACHE_LIST.some(asset => request.url === new URL(asset, self.location.origin).href);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin || CACHE === 'developmentMode' ||
      request.method !== 'GET' || !inCache(request)) {
    return event.respondWith(network(request));
  }
  event.respondWith(request.headers.get('range') ? returnRangeRequest(request) : fromCache(request));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name !== CACHE).map(name => caches.delete(name))))
    .catch(error => console.log('Could not retire old asset caches', error)));
});
