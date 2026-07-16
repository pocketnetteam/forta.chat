importScripts('./js/transports2/fetch/receiver.js');
importScripts('./js/broadcaster.js');

const swBroadcaster = new Broadcaster('ServiceWorker');

const swArgs = new URL(location).searchParams;
const isElectron = (swArgs.get('platform') === 'electron');
const isCapacitor = (swArgs.get('platform') === 'capacitor');

let nodeFetch = (...args) => fetch(...args);

const networkTotalStats = {
  totalTorBytes: 0,
  torSuccessCount: 0,
  directSuccessCount: 0,
  torFailCount: 0,
  directFailCount: 0,
  torBytes: 0,
  directBytes: 0,
};

if (isElectron) {
  nodeFetch = FetchReceiver.init('ExtendedFetch');
}

function onFetch(event) {
  const { request } = event;

  const isHttps = request.url.startsWith('https://');
  const isHttp = request.url.startsWith('http://');
  const isProtocolSupported = (isHttps || isHttp);

  if (!isProtocolSupported) {
    return;
  }

  if (isCapacitor && request.destination === 'document') {
    return;
  }

  if (isCapacitor && request.url.includes('https://localhost')) {
    return;
  }

  async function torAnswerElectron() {
    if (!nodeFetch) {
      return;
    }

    const isTorRequest = await swBroadcaster.invoke('AltTransportActive', request.url);

    if (isTorRequest) {
      return await nodeFetch(request)
        .then(async (response) => {
          const proxyTransportHeader = response.headers.get('#bastyon-proxy-transport');
          const hasUsedTor = (proxyTransportHeader === 'tor');

          const responseClone = response.clone();
          const responseBuffer = await responseClone.arrayBuffer();

          if (hasUsedTor) {
            networkTotalStats.torSuccessCount++;
            networkTotalStats.totalTorBytes += responseBuffer.byteLength;
          } else {
            networkTotalStats.directSuccessCount++;
            networkTotalStats.directBytes += responseBuffer.byteLength;
          }

          swBroadcaster.send('network-stats', {
            status: 'success',
            url: request.url,
            torUsed: hasUsedTor,
            bytesLength: responseBuffer.byteLength,
            totalStats: networkTotalStats,
          });

          return response;
        })
        .catch((err) => {
          networkTotalStats.torFailCount++;

          swBroadcaster.send('network-stats', {
            status: 'failed',
            reason: err,
            url: request.url,
            torUsed: true,
            totalStats: networkTotalStats,
          });

          throw err;
        });
    }
  }

  async function torAnswerCapacitor() {
    const isTorRequest = await swBroadcaster.invoke('AltTransportActive', request.url);

    if (!isTorRequest) {
      return;
    }

    const proxyURL = `http://127.0.0.1:8181/${encodeURIComponent(request.url)}`;
    const fetchInit = {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      credentials: 'omit',
      mode: 'cors',
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchInit.body = request.body;
    }

    return fetch(proxyURL, fetchInit)
      .then(async (response) => {
        const responseClone = response.clone();
        const responseBuffer = await responseClone.arrayBuffer();

        networkTotalStats.torSuccessCount++;
        networkTotalStats.totalTorBytes += responseBuffer.byteLength;

        swBroadcaster.send('network-stats', {
          status: 'success',
          url: request.url,
          torUsed: true,
          bytesLength: responseBuffer.byteLength,
          totalStats: networkTotalStats,
        });

        return response;
      })
      .catch((err) => {
        networkTotalStats.torFailCount++;

        swBroadcaster.send('network-stats', {
          status: 'failed',
          reason: err,
          url: request.url,
          torUsed: true,
          totalStats: networkTotalStats,
        });

        throw err;
      });
  }

  const handle = () => new Promise(async (resolve, reject) => {
    if (isElectron) {
      try {
        const torResponse = await torAnswerElectron();

        if (torResponse) {
          resolve(torResponse);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
    }

    if (isCapacitor) {
      try {
        const torResponse = await torAnswerCapacitor();

        if (torResponse) {
          resolve(torResponse);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
    }

    try {
      const fetchResponse = await fetch(request);

      if (fetchResponse) {
        const responseClone = fetchResponse.clone();
        const responseBuffer = await responseClone.arrayBuffer();

        networkTotalStats.directSuccessCount++;
        networkTotalStats.directBytes += responseBuffer.byteLength;

        swBroadcaster.send('network-stats', {
          status: 'success',
          url: request.url,
          bytesLength: responseBuffer.byteLength,
          totalStats: networkTotalStats,
        });

        resolve(fetchResponse);
      }
    } catch (err) {
      networkTotalStats.directFailCount++;

      swBroadcaster.send('network-stats', {
        status: 'failed',
        reason: err,
        url: request.url,
        totalStats: networkTotalStats,
      });

      reject(err);
    }
  });

  event.respondWith(handle());
}

async function onInstall(event) {
  console.log('Service Worker was successfully installed');
  self.skipWaiting();
}

async function onActivate(event) {
  console.log('Service Worker was successfully activated');
  self.clients.claim();
}

self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('install', event => onInstall(event));
self.addEventListener('fetch', event => onFetch(event));
