'use strict';

var CACHE = '<%= locals.cachebuster %>';

const CACHE_LIST = [
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
    '/bundle/js/bundle.app.js',
    '/bundle/js/bundle.clock.js',
    '/socket.io/socket.io.js',
    '/js/client.js',
    '/images/logo2.png'
];

function returnRangeRequest(request) {
  return caches
    .open(CACHE)
    .then((cache) => {
      return cache.match(request.url);
    })
    .then((res) => {
      if (!res) {
        return fetch(request)
          .then(res => {
            const clonedRes = res.clone();
            return caches
              .open(CACHE)
              .then(cache => cache.put(request, clonedRes))
              .then(() => res);
          })
          .then(res => {
            return res.arrayBuffer();
          });
      }
      return res.arrayBuffer();
    })
    .then((arrayBuffer) => {
      const bytes = /^bytes=(\d+)-(\d+)?$/g.exec(
        request.headers.get('range')
      );
      if (bytes) {
        const start = Number(bytes[1]);
        const end = Number(bytes[2]) || arrayBuffer.byteLength - 1;
        return new Response(arrayBuffer.slice(start, end + 1), {
          status: 206,
          statusText: 'Partial Content',
          headers: [
            ['Content-Range', `bytes ${start}-${end}/${arrayBuffer.byteLength}`]
          ]
        });
      } else {
        return new Response(null, {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: [['Content-Range', `*/${arrayBuffer.byteLength}`]]
        });
      }
    });
}

// Open a cache and `put()` the assets to the cache.
// Return a promise resolving when all the assets are added.
function precache() {
  return caches.open(CACHE)
    .then((cache) => {
    // if any cache requests fail, don't interrupt other requests in progress
    return Promise.allSettled(
      CACHE_LIST.map((url) => {
        // `no-store` in case of partial content responses and
        // because we're making our own cache
        let request = new Request(url, { cache: 'no-store' });
        return fetch(request).then((response) => {
          // console.log('Caching response', url, response);
          cache.put(url, response);
        }).catch((err) => {
          console.log('Could not precache asset', url, err);
        });
      })
    );
  });
}

// Try to read the requested resource from cache.
// If the requested resource does not exist in the cache, fetch it from
// network and cache the response.
function fromCache(request) {
  return caches.open(CACHE).then((cache) => {
    return cache.match(request).then((matching) => {
      console.log(matching);
      if(matching){
        return matching;
      }

      return fetch(request).then((response) => {
        // console.log('Response from network is:', response);
        cache.put(request, response.clone());
        return response;
      }).catch((error) => {
        // This catch() will handle exceptions thrown from the fetch() operation.
        // Note that a HTTP error response (e.g. 404) will NOT trigger an exception.
        // It will return a normal response object that has the appropriate error code set.
        console.error('Fetching failed:', error);

        throw error;
      });
    });
  });
}

// On install, cache some resources.
self.addEventListener('install', (evt) => {
  // console.log('The service worker is being installed.');
  self.skipWaiting();
  evt.waitUntil(precache());
});

function inCache(request) {
  let found = false;
  CACHE_LIST.forEach((e) => {
    if (request.url.endsWith(e)) {
      found = true;
    }
  });
  return found;
}

self.addEventListener('fetch', (evt) => {
  if (!evt.request.url.startsWith(self.location.origin) || CACHE === 'developmentMode' || !inCache(evt.request) || evt.request.method !== 'GET') {
    //console.log('Skipping cache for ',  evt.request.url);
    return void evt.respondWith(fetch(evt.request));
  }
  if (evt.request.headers.get('range')) {
    evt.respondWith(returnRangeRequest(evt.request));
  } else {
    evt.respondWith(fromCache(evt.request));
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE) {
            // console.log('Deleting out of date cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }));

});
