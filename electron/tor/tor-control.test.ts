import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const TorControl = require("./tor-control.cjs");

type Mode = "neveruse" | "auto" | "always";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

let dir: string;

function makeControl(
  settings: { enabled3: Mode; useSnowFlake2?: boolean },
  opts: { installed?: boolean } = {},
) {
  if (opts.installed) fs.writeFileSync(path.join(dir, exe("tor")), "");
  return new TorControl({ path: dir, ...settings });
}

function readTorrc() {
  return fs.readFileSync(path.join(dir, "torrc"), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "forta-torctl-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("electron TorControl — install check", () => {
  it("reports an install is needed when the tor binary is missing", () => {
    const ctl = makeControl({ enabled3: "auto" });

    expect(ctl.needInstall()).toBe(true);
    expect(ctl.isInstalled).toBe(false);
  });

  it("finds an installed tor binary in its folder", () => {
    const ctl = makeControl({ enabled3: "auto" }, { installed: true });

    expect(ctl.needInstall()).toBe(false);
    expect(ctl.getBinPath()).toBe(path.join(dir, exe("tor")));
  });

  it("rethrows a previous install failure without downloading again", async () => {
    const ctl = makeControl({ enabled3: "auto" });
    ctl.installFailed = { code: 500, error: "cantcopy" };

    await expect(ctl.install()).rejects.toEqual({ code: 500, error: "cantcopy" });
  });
});

describe("electron TorControl — bootstrap log", () => {
  it("keeps the latest bootstrap line as status info", () => {
    const ctl = makeControl({ enabled3: "auto" });
    ctl.state.status = "running";

    ctl.log({ data: "Oct 28 [notice] Bootstrapped 45% (loading_descriptors): Loading" });

    expect(ctl.state.info).toBe("Bootstrapped 45% (loading_descriptors): Loading");
    expect(ctl.isRunning()).toBe(true);
  });

  it("switches to started on Bootstrapped 100% and notifies listeners", () => {
    const ctl = makeControl({ enabled3: "auto" });
    const any = vi.fn();
    const started = vi.fn();
    ctl.onAny(any);
    ctl.onStarted(started);

    ctl.log({ data: "[notice] Bootstrapped 100% (done): Done" });

    expect(ctl.isStarted()).toBe(true);
    expect(any).toHaveBeenCalledWith("started");
    expect(started).toHaveBeenCalledWith("started");
  });

  it("notifies only the any-listener for other states", () => {
    const ctl = makeControl({ enabled3: "auto" });
    const any = vi.fn();
    const started = vi.fn();
    ctl.onAny(any);
    ctl.onStarted(started);

    ctl.state.status = "failed";

    expect(any).toHaveBeenCalledWith("failed");
    expect(started).not.toHaveBeenCalled();
  });

  it("clears the bootstrap info once Tor stops", async () => {
    const ctl = makeControl({ enabled3: "auto" });
    ctl.log({ data: "Bootstrapped 100% (done): Done" });

    await ctl.stop();

    expect(ctl.isStopped()).toBe(true);
    expect(ctl.state.info).toBe("");
  });

  it("ignores stderr for the bootstrap state", () => {
    const ctl = makeControl({ enabled3: "auto" });

    ctl.log({ error: "Bootstrapped 100% (done): Done" });

    expect(ctl.isStarted()).toBe(false);
  });
});

describe("electron TorControl — torrc", () => {
  it("writes the SOCKS/control ports and quotes data paths", async () => {
    const ctl = makeControl({ enabled3: "auto" });

    expect(await ctl.makeConfig()).toBe(true);

    const torrc = readTorrc();
    expect(torrc).toContain("SocksPort 9250");
    expect(torrc).toContain("ControlPort 9251");
    expect(torrc).toContain(`DataDirectory "${path.join(dir, "data")}"`);
    expect(torrc).toContain(`GeoIPFile "${path.join(dir, "geoip")}"`);
    expect(torrc).not.toContain("UseBridges");
  });

  it("adds Snowflake bridges when enabled and the client is installed", async () => {
    const ptDir = path.join(dir, "pluggable_transports");
    fs.mkdirSync(ptDir);
    fs.writeFileSync(path.join(ptDir, exe("snowflake-client")), "");
    const ctl = makeControl({ enabled3: "always", useSnowFlake2: true });

    await ctl.makeConfig();

    const torrc = readTorrc();
    expect(torrc).toContain("UseBridges 1");
    expect(torrc).toMatch(/^ClientTransportPlugin snowflake exec .*snowflake-client/m);
    expect(torrc.match(/^Bridge snowflake /gm)).toHaveLength(2);
  });

  it("skips bridges when Snowflake is enabled but the client is missing", async () => {
    const ctl = makeControl({ enabled3: "always", useSnowFlake2: true });

    await ctl.makeConfig();

    expect(readTorrc()).not.toContain("UseBridges");
  });

  it("replaces a previous torrc", async () => {
    fs.writeFileSync(path.join(dir, "torrc"), "Stale 1");
    const ctl = makeControl({ enabled3: "auto" });

    await ctl.makeConfig();

    expect(readTorrc()).not.toContain("Stale");
  });
});

describe("electron TorControl — start", () => {
  it("neveruse without a binary stays stopped and does not download", async () => {
    const ctl = makeControl({ enabled3: "neveruse" });
    const install = vi.spyOn(ctl, "install");

    expect(await ctl.start()).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(ctl.isStopped()).toBe(true);
  });

  it("does not start a second install while one is running", async () => {
    const ctl = makeControl({ enabled3: "auto" });
    const install = vi.spyOn(ctl, "install");
    ctl.state.status = "install";

    expect(await ctl.start()).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("marks the state failed when the install fails", async () => {
    const ctl = makeControl({ enabled3: "auto" });
    vi.spyOn(ctl, "install").mockRejectedValue({ code: 500, error: "cantcopy" });

    expect(await ctl.start()).toBe(false);
    expect(ctl.state.status).toBe("failed");
  });

  it("neveruse with an installed binary does not start", async () => {
    const ctl = makeControl({ enabled3: "neveruse" }, { installed: true });
    const makeConfig = vi.spyOn(ctl, "makeConfig");

    expect(await ctl.start()).toBe(false);
    expect(makeConfig).not.toHaveBeenCalled();
  });

  it("does not spawn again while Tor is already running", async () => {
    const ctl = makeControl({ enabled3: "auto" }, { installed: true });
    const makeConfig = vi.spyOn(ctl, "makeConfig");
    ctl.state.status = "running";

    expect(await ctl.start()).toBe(true);
    expect(makeConfig).not.toHaveBeenCalled();
  });

  it("init creates the Tor folder and leaves neveruse stopped", async () => {
    const nested = path.join(dir, "nested", "tor");
    const ctl = new TorControl({ path: nested, enabled3: "neveruse" });
    const start = vi.spyOn(ctl, "start");

    await ctl.init();

    expect(fs.statSync(nested).isDirectory()).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("init starts Tor for auto", async () => {
    const ctl = makeControl({ enabled3: "auto" });
    const start = vi.spyOn(ctl, "start").mockResolvedValue(true);

    await ctl.init();

    expect(start).toHaveBeenCalled();
  });
});

describe("electron TorControl — settingChanged", () => {
  function spied(settings: { enabled3: Mode; useSnowFlake2?: boolean }) {
    const ctl = makeControl(settings);
    return {
      ctl,
      start: vi.spyOn(ctl, "start").mockResolvedValue(true),
      stop: vi.spyOn(ctl, "stop").mockResolvedValue(true),
      restart: vi.spyOn(ctl, "restart").mockResolvedValue(undefined),
    };
  }

  it("does nothing when neither mode nor bridges change", async () => {
    const { ctl, start, stop, restart } = spied({ enabled3: "auto", useSnowFlake2: false });

    await ctl.settingChanged({ enabled3: "auto", useSnowFlake2: false });

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("stops Tor when switched to neveruse", async () => {
    const { ctl, stop } = spied({ enabled3: "always" });

    await ctl.settingChanged({ enabled3: "neveruse" });

    expect(stop).toHaveBeenCalled();
    expect(ctl.settings.enabled3).toBe("neveruse");
  });

  it("starts Tor when switched on from neveruse", async () => {
    const { ctl, start, restart } = spied({ enabled3: "neveruse" });

    await ctl.settingChanged({ enabled3: "auto" });

    expect(start).toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts Tor when switching between auto and always", async () => {
    const { ctl, restart } = spied({ enabled3: "auto" });

    await ctl.settingChanged({ enabled3: "always" });

    expect(restart).toHaveBeenCalled();
  });

  it("restarts Tor when Snowflake is toggled", async () => {
    const { ctl, restart } = spied({ enabled3: "always", useSnowFlake2: false });

    await ctl.settingChanged({ enabled3: "always", useSnowFlake2: true });

    expect(restart).toHaveBeenCalled();
  });

  it("marks the state failed when applying the change throws", async () => {
    const { ctl, start } = spied({ enabled3: "neveruse" });
    start.mockRejectedValue(new Error("boom"));

    await ctl.settingChanged({ enabled3: "auto" });

    expect(ctl.state.status).toBe("failed");
  });
});

describe("electron TorControl — auto idle timer", () => {
  it("stops Tor after 5 idle minutes", async () => {
    vi.useFakeTimers();
    const ctl = makeControl({ enabled3: "auto" });
    const stop = vi.spyOn(ctl, "stop");

    ctl.startTimer();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 5000);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("resetTimer postpones the idle shutdown", async () => {
    vi.useFakeTimers();
    const ctl = makeControl({ enabled3: "auto" });
    const stop = vi.spyOn(ctl, "stop");

    ctl.startTimer();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    ctl.resetTimer();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    expect(stop).not.toHaveBeenCalled();
  });

  it("stop clears the idle timer and a remembered install failure", async () => {
    vi.useFakeTimers();
    const ctl = makeControl({ enabled3: "auto" });
    ctl.installFailed = { code: 500, error: "cantcopy" };
    ctl.startTimer();

    await ctl.stop();

    expect(ctl.timeoutIntervalId).toBeNull();
    expect(ctl.installFailed).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
