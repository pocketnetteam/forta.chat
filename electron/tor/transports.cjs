/**
 * Transport layer that decides whether to route requests through Tor.
 *
 * Simplified from pocketnet/proxy16/transports.js — only WrappedFetch
 * (no axios/request wrappers).
 */

const nodeFetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');
const net = require('net');

class WrappedFetch {
  constructor(transportsInstance) {
    this.transports = transportsInstance;
  }

  static instantiate(transportsInstance) {
    const wrappedFetch = new WrappedFetch(transportsInstance);
    return (...args) => wrappedFetch.fetch(...args);
  }

  async fetch(url, options) {
    const torCtrl = this.transports.torControl;
    const preparedArgs = { ...options };

    const isTorEnabledInSettings = (torCtrl.settings.enabled3 !== 'neveruse');
    const isDirectAccessRestricted = (torCtrl.settings.enabled3 === 'always');

    let useDirectAccess = false;
    if (!isTorEnabledInSettings) {
      useDirectAccess = true;
    } else if (!isDirectAccessRestricted) {
      useDirectAccess = await this.transports.hasDirectAccess(url);
    }

    let isTorReady = this.transports.isTorReady();

    if (isDirectAccessRestricted) {
      isTorReady = await this.transports.waitTorReady();
    }

    const useTor = (!useDirectAccess && isTorReady && isTorEnabledInSettings);
    if (useTor) {
      if (torCtrl.settings.enabled3 === 'auto') {
        torCtrl.resetTimer();
      }
      preparedArgs.agent = this.transports.getTorAgent();
    } else if (isDirectAccessRestricted && !isTorReady) {
      return Promise.reject(new TypeError('Failed to fetch'));
    }

    return nodeFetch(url, preparedArgs)
      .then((response) => {
        return WrappedFetch.handleSuccess(response, {
          isAgentAttached: !!preparedArgs.agent,
        });
      })
      .catch(async (error) => {
        if (!!preparedArgs.agent && this.transports.checkForAgentError(error)) {
          return WrappedFetch.handleError(error);
        }

        if (error.code !== 'ECONNREFUSED' &&
            error.code !== 'ETIMEDOUT' &&
            error.code !== 'ENOTFOUND' &&
            error.code !== 'ECONNRESET') {
          return Promise.reject(error);
        }

        if (!preparedArgs.agent && torCtrl.settings.enabled3 === 'auto') {
          // The host failed directly: without this the retry trusts the cached
          // probe (good for 30 min) and goes direct again.
          this.transports.markNoDirectAccess(url);
        }

        // Retry with Tor on network errors
        const isTorEnabled2 = (torCtrl.settings.enabled3 !== 'neveruse');
        const isRestricted2 = (torCtrl.settings.enabled3 === 'always');
        const isAuto2 = (torCtrl.settings.enabled3 === 'auto');

        let useDirectAccess2 = false;
        if (!isTorEnabled2) {
          useDirectAccess2 = true;
        } else if (!isRestricted2) {
          useDirectAccess2 = await this.transports.hasDirectAccess(url);
        }

        let isTorReady2 = this.transports.isTorReady();
        if (isRestricted2) {
          isTorReady2 = await this.transports.waitTorReady();
        }

        const torRefuse = this.transports.isTorRefuseConnections(error);
        const useTor2 = (!useDirectAccess2 && isTorReady2 && isTorEnabled2 &&
          !(torRefuse && isAuto2));

        if (useTor2) {
          if (isAuto2) torCtrl.resetTimer();
          preparedArgs.agent = this.transports.getTorAgent();
        } else if (isRestricted2 && !isTorReady2) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }

        return nodeFetch(url, preparedArgs)
          .then((response) => WrappedFetch.handleSuccess(response, {
            isAgentAttached: !!preparedArgs.agent,
          }))
          .catch((error) => WrappedFetch.handleError(error));
      });
  }

  static handleSuccess(response, args = {}) {
    if (args.isAgentAttached) {
      response.headers.append('#bastyon-proxy-transport', 'tor');
    } else {
      response.headers.append('#bastyon-proxy-transport', 'direct');
    }
    return Promise.resolve(response);
  }

  static handleError(error) {
    const isConnRefused = error.message.includes('ECONNREFUSED 127.0.0.1:9250');
    const isSocksRejection = error.message.includes('Socks5 proxy rejected connection');

    if (isConnRefused || isSocksRejection) {
      console.warn('SOCKS5 proxy rejection');
      return;
    }
    return Promise.reject(error);
  }
}

class Transports {
  accessRecords = {};
  torAgent = null;
  torStartPromise = null;
  resolveTorStart = null;

  constructor(torControl) {
    this.torControl = torControl;
    this.fetch = WrappedFetch.instantiate(this);
    if (torControl) {
      torControl.onAny((status) => this.settleTorStart(status));
    }
  }

  static waitTimeout = (seconds, orReturn) => new Promise((resolve) => {
    setTimeout(() => resolve(orReturn), seconds * 1000);
  });

  async hasDirectAccess(url) {
    let { hostname, port, protocol } = new URL(url);

    if (!port) {
      port = (protocol === 'https:') ? 443 : 80;
    }

    const isIPAddress = (address) => {
      const ipv4Like = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Like = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
      return ipv4Like.test(address) || ipv6Like.test(address);
    };

    // Localhost always has direct access
    const isLocal = (addr) => /^(127(?:\.\d{1,3}){0,3}|0\.0\.0\.0|::1|::)$/.test(addr);
    if (isIPAddress(hostname) && isLocal(hostname)) {
      return true;
    }

    const isHostListed = (hostname in this.accessRecords);

    if (!isHostListed) {
      this.accessRecords[hostname] = {};
      this.accessRecords[hostname].inProgress = this.pingHost(hostname, port)
        .then((result) => {
          this.accessRecords[hostname] = { accessOk: result };
          // Retry in 30 min on success, 10 min on failure
          this.accessRecords[hostname].nextTry = Date.now() +
            (result ? 30 * 60 * 1000 : 10 * 60 * 1000);
          return result;
        });
    }

    const pingPromise = this.accessRecords[hostname].inProgress;
    if (pingPromise instanceof Promise) {
      await pingPromise;
    }

    const isAccessOk = (this.accessRecords[hostname].accessOk === true);
    const isPingInProgress = (this.accessRecords[hostname].inProgress === true);
    const isNextTryTime = (this.accessRecords[hostname].nextTry <= Date.now());

    if (isNextTryTime && !isPingInProgress) {
      const pingResult = await this.pingHost(hostname, port);
      this.accessRecords[hostname] = {
        accessOk: pingResult,
        nextTry: Date.now() + (pingResult ? 30 * 60 * 1000 : 10 * 60 * 1000),
      };
    }

    return isAccessOk;
  }

  async pingHost(host, port) {
    function synackPing(timeout) {
      const isLocalhost = (address) => /^(127(?:\.\d{1,3}){0,3}|0\.0\.0\.0|::1|::)$/.test(address);

      return new Promise((resolve, reject) => {
        let socket;
        try {
          socket = net.createConnection(port, host, () => {
            socket.end();
            socket.destroy();
            resolve(true);
          });
        } catch (err) {
          reject('SYNACK_PING_FAILED');
          return;
        }

        socket.setTimeout(timeout);

        socket.on('lookup', (err, address) => {
          if (isLocalhost(address)) {
            socket.end();
            socket.destroy();
            reject('SYNACK_PING_LOCALHOST');
          }
        });

        socket.on('error', (err) => {
          socket.end();
          socket.destroy();
          const messages = [
            ...(Array.isArray(err.errors) ? err.errors.map(e => e.message || e.toString() || '') : []),
            err.message || err.toString()
          ];
          if (messages.some(m => m.includes('ETIMEDOUT'))) {
            reject('SYNACK_PING_TIMEOUT');
          } else {
            reject('SYNACK_PING_FAILED');
          }
        });

        socket.on('timeout', () => {
          socket.end();
          socket.destroy();
          reject('SYNACK_PING_TIMEOUT');
        });
      });
    }

    const timeouts = [200, 300, 500];
    for (const timeout of timeouts) {
      try {
        return await synackPing(timeout);
      } catch (e) {
        if (e === 'SYNACK_PING_FAILED') {
          await Transports.waitTimeout(timeout / 1000, false);
        } else if (e === 'SYNACK_PING_LOCALHOST') {
          return false;
        }
      }
    }
    return false;
  }

  /** The next check of this host answers "no direct access" and probes it again for the ones after. */
  markNoDirectAccess(url) {
    const { hostname } = new URL(url);
    this.accessRecords[hostname] = { accessOk: false, nextTry: 0 };
  }

  /**
   * True at once when Tor is up; otherwise waits for its next outcome (started,
   * failed, or switched off), at most 60 s. The wait used to be one promise for the
   * app's life: the first outcome answered every later call, so a failed first
   * start kept "always" mode refusing requests after Tor came up.
   */
  async waitTorReady() {
    if (this.isTorReady()) return true;

    if (!this.torStartPromise) {
      this.torStartPromise = new Promise((resolve) => {
        const timer = setTimeout(() => this.finishTorWait(false), 60 * 1000);
        this.resolveTorStart = (isStarted) => {
          clearTimeout(timer);
          resolve(isStarted);
        };
      });
    }

    return this.torStartPromise;
  }

  settleTorStart(status) {
    if (status === 'started') {
      this.finishTorWait(true);
    } else if (status === 'failed') {
      this.finishTorWait(false);
    } else if (status === 'stopped' && this.torControl.settings.enabled3 === 'neveruse') {
      // Install and restart() pass through 'stopped' on the way up: only a
      // stop the user asked for answers the wait.
      this.finishTorWait(false);
    }
  }

  finishTorWait(isStarted) {
    const resolve = this.resolveTorStart;
    this.torStartPromise = null;
    this.resolveTorStart = null;
    if (resolve) resolve(isStarted);
  }

  isTorReady() {
    return this.torControl && this.torControl.isStarted();
  }

  getTorAgent() {
    if (!this.torAgent) {
      this.torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9250', {
        keepAlive: true,
        timeout: 60000,
      });
    }
    return this.torAgent;
  }

  async isTorNeeded(url) {
    const torCtrl = this.torControl;

    const isTorEnabledInSettings = (torCtrl.settings.enabled3 !== 'neveruse');
    const isDirectAccessRestricted = (torCtrl.settings.enabled3 === 'always');

    let useDirectAccess = false;
    if (!isTorEnabledInSettings) {
      useDirectAccess = true;
    } else if (!isDirectAccessRestricted) {
      useDirectAccess = await this.hasDirectAccess(url);
    }

    let isTorReady = this.isTorReady();

    if (!useDirectAccess && !isTorReady) {
      torCtrl.start();
      isTorReady = await this.waitTorReady();
    }

    const useTor = (!useDirectAccess && isTorReady && isTorEnabledInSettings);
    return !!useTor;
  }

  checkForAgentError(error) {
    const isSocksRejected = /Socks5 proxy rejected connection/;
    const isSocketNotCreated = /A "socket" was not created/;
    return (
      isSocksRejected.test(error.message) ||
      isSocketNotCreated.test(error.message)
    );
  }

  isTorRefuseConnections(error) {
    return error.message.includes('ECONNREFUSED 127.0.0.1:9250');
  }
}

module.exports = Transports;
