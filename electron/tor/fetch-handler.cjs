/**
 * Main-process handler for fetch requests forwarded from the Service Worker
 * via the renderer's FetchBridge IPC.
 *
 * Adapted from pocketnet/js/transports2/fetch/handler.js
 */

const FetchBridgeEventsGroup = 'FetchBridge';

class FetchMainHandler {
  requests = {};

  constructor(ipcMain) {
    this.ipcMain = ipcMain;
  }

  send(eventName, requestId, data) {
    const sender = this.requests[requestId]?.sender;
    if (!sender || sender.isDestroyed()) return;
    sender.send(`${FetchBridgeEventsGroup}:${requestId}:${eventName}`, data);
  }

  listen(eventName, requestId, listener) {
    this.ipcMain.once(`${FetchBridgeEventsGroup}:${requestId}:${eventName}`, (...args) => {
      listener(...args);
    });
  }

  unlisten(eventName, requestId) {
    this.ipcMain.removeAllListeners(`${FetchBridgeEventsGroup}:${requestId}:${eventName}`);
  }

  onRequest(listener) {
    this.ipcMain.on(`${FetchBridgeEventsGroup}:Request`, (e, requestId, requestInit) => {
      this.requests[requestId] = { sender: e.sender };
      listener(requestId, requestInit);
    });
  }

  onAbort(requestId, listener) {
    this.listen('Abort', requestId, listener);
  }

  offAbort(requestId) {
    this.unlisten('Abort', requestId);
  }

  sendInitialData(requestId, initData) {
    this.send('InitialData', requestId, initData);
  }

  sendData(requestId, data) {
    this.send('Data', requestId, [...data]);
  }

  sendEnd(requestId) {
    this.send('End', requestId);
  }

  sendError(requestId, error) {
    this.send('Error', requestId, error);
  }

  static init(ipcMain, options = {}) {
    const self = new FetchMainHandler(ipcMain);

    self.onRequest((requestId, requestData) => {
      const controller = new AbortController();
      const signal = controller.signal;
      // The renderer sends Abort when the page cancels the request; nothing
      // listened, so a cancelled download kept streaming through Tor.
      self.onAbort(requestId, () => {
        controller.abort();
        delete self.requests[requestId];
      });

      const url = requestData.url;
      delete requestData.url;

      options.fetchFunction(url, { signal, ...requestData })
        .then((data) => {
          const { status } = data;
          const headers = {};

          data.headers.forEach((value, name) => {
            headers[name] = value;
          });

          self.sendInitialData(requestId, { url, status, headers });

          data.body.on('data', (chunk) => {
            self.sendData(requestId, chunk);
          });

          data.body.on('end', () => {
            self.offAbort(requestId);
            self.sendEnd(requestId);
            delete self.requests[requestId];
          });

          // A socket error mid-body (Tor circuit dropped, abort) is emitted on
          // the stream; with no listener it was an uncaught exception in the
          // main process.
          data.body.on('error', () => {
            self.offAbort(requestId);
            self.sendError(requestId);
            delete self.requests[requestId];
          });
        })
        .catch((err) => {
          if (err.code !== 'FETCH_ABORTED') {
            self.offAbort(requestId);
            self.sendError(requestId);
            delete self.requests[requestId];
          }
        });
    });

    return self;
  }
}

module.exports = FetchMainHandler;
