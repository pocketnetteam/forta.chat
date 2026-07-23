/**
 * Tor binary management: download, configure, spawn, and lifecycle control.
 *
 * Simplified from pocketnet/proxy16/node/torcontrol.js — no Applications/nedb
 * dependency; uses built-in Node.js https + tar for download/extraction.
 */

const path = require('path');
const child_process = require('child_process');
const fs = require('fs/promises');
const fssync = require('fs');
const https = require('https');
const tar = require('tar');
const kill = require('tree-kill');

// ---------------------------------------------------------------------------
// Platform → release asset name mapping
// ---------------------------------------------------------------------------
const PLATFORM_ASSETS = {
  'darwin-x64':  'macos-x86_64.tar.gz',
  'darwin-arm64': 'macos-x86_64.tar.gz',   // Rosetta
  'win32-x64':   'windows-x86_64.tar.gz',
  'win32-ia32':  'windows-i686.tar.gz',
  'linux-x64':   'linux-x86_64.tar.gz',
  'linux-ia32':  'linux-i686.tar.gz',
};

const RELEASES_API = 'https://api.github.com/repos/shpingalet007/tor-builds/releases/latest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function binName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function checkPath(pathname) {
  try {
    const stat = fssync.lstatSync(pathname);
    return { exists: true, isFolder: stat.isDirectory() };
  } catch {
    return { exists: false, isFolder: null };
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = typeof url === 'string' ? url : url;
    const req = https.get(options, { headers: { 'User-Agent': 'forta-chat' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, { headers: { 'User-Agent': 'forta-chat' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        const file = fssync.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
class State {
  _status = 'stopped';
  info = '';

  constructor(control) {
    this.control = control;
  }

  get status() { return this._status; }

  set status(value) {
    this._status = value;
    for (const listener of this.control.listeners) {
      if (listener.type === 'any' || listener.type === value) {
        listener.listener(value);
      }
    }
    if (value !== 'running' && value !== 'started') {
      this.info = '';
    }
  }
}

// ---------------------------------------------------------------------------
// TorControl
// ---------------------------------------------------------------------------
class TorControl {
  state;
  instance = null;
  listeners = [];
  settings = {};
  installFailed = null;
  timeoutIntervalId = null;
  timeoutCounter = null;

  constructor(settings) {
    this.settings = { ...settings };
    this.state = new State(this);
    this.needInstall();
  }

  // -- state queries --------------------------------------------------------
  isStarted  = () => this.state.status === 'started';
  isStopped  = () => this.state.status === 'stopped';
  isRunning  = () => this.state.status === 'running';

  // -- listener registration ------------------------------------------------
  onAny     = (listener) => this.listeners.push({ type: 'any', listener });
  onStarted = (listener) => this.listeners.push({ type: 'started', listener });

  // -- paths ----------------------------------------------------------------
  getSettingsPath = () => this.settings.path;
  getBinPath      = () => path.join(this.getSettingsPath(), binName('tor'));

  // -- init -----------------------------------------------------------------
  async init() {
    try {
      await this.ensureFolders();
      if (this.settings.enabled3 !== 'neveruse') {
        await this.start();
      }
    } catch (e) {
      console.error('Tor control failed to start:', e);
      this.state.status = 'failed';
    }
  }

  // -- folder setup ---------------------------------------------------------
  async ensureFolders() {
    const check = checkPath(this.getSettingsPath());
    if (!check.exists) {
      await fs.mkdir(this.getSettingsPath(), { recursive: true });
    } else if (check.exists && !check.isFolder) {
      await fs.rm(this.getSettingsPath(), { recursive: true });
      await this.ensureFolders();
    }
  }

  // -- install check --------------------------------------------------------
  needInstall() {
    const exists = checkPath(this.getBinPath());
    this.isInstalled = exists.exists;
    return !exists.exists;
  }

  // -- download & extract ---------------------------------------------------
  async install() {
    if (this.installFailed) throw this.installFailed;

    try {
      this.state.status = 'install';

      const platformKey = `${process.platform}-${process.arch}`;
      const assetName = PLATFORM_ASSETS[platformKey];
      if (!assetName) throw new Error(`Unsupported platform: ${platformKey}`);

      // Fetch latest release metadata
      const metaRaw = await httpsGet(RELEASES_API);
      const meta = JSON.parse(metaRaw.toString());
      const asset = meta.assets.find((a) => a.name.includes(assetName));
      if (!asset) throw new Error(`Asset ${assetName} not found in release`);

      // Download tarball
      const tmpPath = path.join(this.getSettingsPath(), asset.name);
      await downloadToFile(asset.browser_download_url, tmpPath);

      // Extract
      await tar.x({ file: tmpPath, cwd: this.getSettingsPath() });

      // Cleanup
      await fs.unlink(tmpPath);
      await fs.chmod(this.getSettingsPath(), 0o755);
      await fs.chmod(this.getBinPath(), 0o755);

      this.state.status = 'stopped';
      this.needInstall();
      return true;
    } catch (e) {
      this.installFailed = { code: 500, error: 'cantcopy' };
      this.state.status = 'failed';
      throw this.installFailed;
    }
  }

  // -- torrc generation -----------------------------------------------------
  async makeConfig() {
    const useSnowFlake2 = this.settings.useSnowFlake2 || false;
    const sp = (...parts) => path.join(this.getSettingsPath(), ...parts);
    // Quote paths for torrc — spaces in dirs like "Application Support" break parsing
    const q = (p) => `"${p}"`;

    try { await fs.unlink(sp('torrc')); } catch {}

    let torConfig = [
      '# Auto-generated torrc for Forta Chat',
      'SocksPort 9250',
      'ControlPort 9251',
      'CookieAuthentication 1',
      'DormantCanceledByStartup 1',
      `DataDirectory ${q(sp('data'))}`,
      'Log notice stdout',
      'AvoidDiskWrites 1',
      `GeoIPFile ${q(sp('geoip'))}`,
      `GeoIPv6File ${q(sp('geoip6'))}`,
      'KeepalivePeriod 10',
    ];

    const snowflakeBin = sp('pluggable_transports', binName('snowflake-client'));
    const snowflakeExists = checkPath(snowflakeBin).exists;
    let snowflakeExecPath = snowflakeBin;

    // Tor's ClientTransportPlugin exec can't handle spaces in paths.
    // Workaround: symlink from a space-free temp directory.
    if (useSnowFlake2 && snowflakeExists && snowflakeBin.includes(' ')) {
      try {
        const os = require('os');
        const linkDir = path.join(os.tmpdir(), 'forta-tor-pt');
        if (!checkPath(linkDir).exists) fssync.mkdirSync(linkDir, { recursive: true });
        const linkPath = path.join(linkDir, binName('snowflake-client'));
        try { fssync.unlinkSync(linkPath); } catch {}
        fssync.symlinkSync(snowflakeBin, linkPath);
        fssync.chmodSync(linkPath, 0o755);
        snowflakeExecPath = linkPath;
        console.log('Snowflake symlinked to space-free path:', linkPath);
      } catch (e) {
        console.warn('Failed to create snowflake symlink, skipping bridges:', e.message);
      }
    }

    if (useSnowFlake2 && !snowflakeExists) {
      console.warn('Snowflake bridges requested but binary not found at:', snowflakeBin);
    }

    if (useSnowFlake2 && snowflakeExists) {
      // CDN77 fronts (Tor Browser / Orbot) — AMP/Google fronts often blocked in RU.
      const ice = [
        'stun:stun.antisip.com:3478',
        'stun:stun.epygi.com:3478',
        'stun:stun.uls.co.za:3478',
        'stun:stun.voipgate.com:3478',
        'stun:stun.mixvoip.com:3478',
        'stun:stun.nextcloud.com:443',
        'stun:stun.sonetel.net:3478',
        'stun:stun.voipia.net:3478',
        'stun:stun.voys.nl:3478',
      ].join(',');
      const fronts = 'www.phpmyadmin.net,cdn.zk.mk';
      const broker = 'https://1098762253.rsc.cdn77.org/';
      torConfig.push(
        '',
        'UseBridges 1',
        `ClientTransportPlugin snowflake exec ${snowflakeExecPath}`,
        `Bridge snowflake 192.0.2.4:80 8838024498816A039FCBBAB14E6F40A0843051FA fingerprint=8838024498816A039FCBBAB14E6F40A0843051FA url=${broker} fronts=${fronts} ice=${ice} utls-imitate=hellorandomizedalpn`,
        `Bridge snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=${broker} fronts=${fronts} ice=${ice} utls-imitate=hellorandomizedalpn`,
      );
    }

    try {
      await fs.writeFile(sp('torrc'), torConfig.join('\n'), { flag: 'w' });
      console.log('Tor config created');
      return true;
    } catch (e) {
      console.error('Tor config creation failed:', e.message);
      return false;
    }
  }

  // -- autorun logic --------------------------------------------------------
  async autorun() {
    if (this.instance || this.state.status !== 'stopped') {
      if (this.settings.enabled3 === 'neveruse') {
        await this.stop();
      } else {
        await this.restart();
      }
    } else {
      if (this.settings.enabled3 !== 'neveruse' && this.needInstall()) {
        await this.install();
      }
      if (this.settings.enabled3 === 'always') {
        await this.restart();
      }
    }
  }

  // -- start / stop ---------------------------------------------------------
  async start() {
    console.log('Tor start triggered');

    if (this.needInstall()) {
      if (this.state.status === 'install') return false;
      if (this.settings.enabled3 === 'neveruse') {
        this.state.status = 'stopped';
        return false;
      }
      try { await this.install(); } catch (e) {
        console.error('Tor failed to install:', e);
        this.state.status = 'failed';
        return false;
      }
    }

    if (this.settings.enabled3 === 'neveruse') return false;
    if (this.state.status !== 'stopped') return true;

    this.state.status = 'running';

    if (this.settings.enabled3 === 'auto') {
      this.startTimer();
    }

    const configCreated = await this.makeConfig();
    if (!configCreated) console.warn('Tor config creation failed');

    await this.getPidAndKill();

    this.instance = child_process.spawn(this.getBinPath(), [
      '-f', path.join(this.getSettingsPath(), 'torrc'),
    ], {
      stdio: ['ignore'],
      detached: false,
      shell: false,
      env: { 'LD_LIBRARY_PATH': this.getSettingsPath() },
    });

    this.instance.on('error', () => this.stop());

    this.instance.on('exit', (code) => {
      if (code) console.error(`Tor exited with code: ${code}`);
      this.stop();
    });

    this.instance.stderr.on('data', (chunk) => this.log({ error: String(chunk) }));
    this.instance.stdout.on('data', (chunk) => this.log({ data: String(chunk) }));

    this.savePid(this.instance.pid);
    console.log('Tor running with pid:', this.instance.pid);
    return true;
  }

  async stop() {
    if (this.instance) {
      try { await this.getPidAndKill(); } catch (e) {
        console.warn('Tor instance kill error:', e.message);
      }
    }
    this.state.status = 'stopped';
    this.instance = null;
    this.installFailed = null;
    clearInterval(this.timeoutIntervalId);
    this.timeoutIntervalId = null;
    return true;
  }

  async restart() {
    try {
      await this.stop();
      setTimeout(() => this.start(), 2000);
    } catch (e) {
      console.error(e);
    }
  }

  // -- idle timer (auto mode) -----------------------------------------------
  startTimer() {
    const minutes5 = 5 * 60 * 1000;
    this.timeoutCounter = minutes5;
    this.timeoutIntervalId = setInterval(() => {
      this.timeoutCounter -= 5000;
      if (this.timeoutCounter <= 0) {
        console.log('Tor idle for 5 minutes — shutting down');
        this.stop();
        this.timeoutCounter = null;
        clearInterval(this.timeoutIntervalId);
      }
    }, 5000);
  }

  resetTimer() {
    this.timeoutCounter = 5 * 60 * 1000;
  }

  // -- stdout log parser ----------------------------------------------------
  log(data) {
    try {
      if (data.error) {
        console.error('[Tor stderr]', data.error.trim());
      }
      if (data.data) {
        const lines = data.data.trim();
        console.log('[Tor]', lines);
      }

      const isBootstrapped100 = (d) => d.data?.includes('Bootstrapped 100%');
      const extractBootstrap = (d) => (d.data?.match(/Bootstrapped \d+%.*/) || [null])[0];

      const message = extractBootstrap(data);
      if (message !== null) this.state.info = message;

      if (isBootstrapped100(data)) {
        console.log('Tor bootstrapped — ready');
        this.state.status = 'started';
      }
    } catch (e) {
      console.error(e);
    }
  }

  // -- settings change (runtime mode toggle) --------------------------------
  async settingChanged(settings) {
    const isTorStateChanged = (settings.enabled3 !== this.settings.enabled3);
    const isBridgeChanged = (
      typeof settings.useSnowFlake2 === 'boolean'
      && settings.useSnowFlake2 !== this.settings.useSnowFlake2
    );
    const wasDisabled = this.settings.enabled3 === 'neveruse';
    this.settings = { ...settings };

    if (!isTorStateChanged && !isBridgeChanged) return;

    try {
      if (settings.enabled3 === 'neveruse') {
        await this.stop();
      } else if (wasDisabled) {
        await this.start();
      } else if (isBridgeChanged || isTorStateChanged) {
        await this.restart();
      }
    } catch (e) {
      this.state.status = 'failed';
    }
  }

  // -- PID management -------------------------------------------------------
  async savePid(pid) {
    try {
      await fs.writeFile(
        path.join(this.getSettingsPath(), 'tor.pid'),
        pid.toString(),
        { encoding: 'utf-8' },
      );
    } catch (e) {
      console.error(e);
    }
  }

  async getPidAndKill() {
    let pid;
    if (this.instance) {
      pid = +this.instance.pid.toString();
    } else {
      const pidFile = path.join(this.getSettingsPath(), 'tor.pid');
      try {
        pid = await fs.readFile(pidFile, { encoding: 'utf-8' });
      } catch {
        return false;
      }
    }

    return new Promise((resolve) => {
      kill(+pid.toString(), (err) => {
        if (err) {
          console.error('Unable to kill Tor instance:', err);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
}

module.exports = TorControl;
