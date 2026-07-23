import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  pickLiveMatrixHost,
  nextMatrixHost,
  hostFromBaseUrl,
  SyncWatchdog,
  type SyncWatchdogDeps,
} from "../sync-failover";
import { MATRIX_SERVER, MATRIX_MIRRORS } from "@/shared/config/constants";

const HOSTS = [MATRIX_SERVER, ...MATRIX_MIRRORS] as const;

describe("pickLiveMatrixHost — ping-and-pick живого homeserver", () => {
  it("выбирает первый отвечающий из [primary, ...mirrors] (primary жив → primary)", async () => {
    const probe = vi.fn(async (host: string) => host === MATRIX_SERVER);
    const picked = await pickLiveMatrixHost(probe, HOSTS);
    expect(picked).toBe(MATRIX_SERVER);
    // Hot path (A5): healthy primary → no mirror probe at all.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(MATRIX_SERVER);
  });

  it("primary мёртв → берёт первый живой mirror", async () => {
    const probe = vi.fn(async (host: string) => host !== MATRIX_SERVER);
    const picked = await pickLiveMatrixHost(probe, HOSTS);
    expect(picked).toBe(MATRIX_MIRRORS[0]);
  });

  it("primary бросает исключение → продолжает к mirror", async () => {
    const probe = vi.fn(async (host: string) => {
      if (host === MATRIX_SERVER) throw new Error("ECONNREFUSED");
      return true;
    });
    const picked = await pickLiveMatrixHost(probe, HOSTS);
    expect(picked).toBe(MATRIX_MIRRORS[0]);
  });

  it("никто не отвечает → fallback на primary (boot-retry разрулит)", async () => {
    const probe = vi.fn(async () => false);
    const picked = await pickLiveMatrixHost(probe, HOSTS);
    expect(picked).toBe(MATRIX_SERVER);
  });

  it("соблюдает приоритет mirror-порядка: первый живой при мёртвом primary", async () => {
    // primary "a.host" dead, both mirrors live → first mirror wins.
    const probe = vi.fn(async (host: string) => host !== "a.host");
    const picked = await pickLiveMatrixHost(probe, ["a.host", "b.host", "c.host"]);
    expect(picked).toBe("b.host");
  });
});

describe("nextMatrixHost / hostFromBaseUrl — host rotation", () => {
  it("ротация primary → mirror → primary (wrap)", () => {
    expect(nextMatrixHost(MATRIX_SERVER)).toBe(MATRIX_MIRRORS[0]);
    expect(nextMatrixHost(MATRIX_MIRRORS[0])).toBe(MATRIX_SERVER);
  });

  it("неизвестный host → первый mirror", () => {
    expect(nextMatrixHost("unknown.host", ["p", "m1", "m2"])).toBe("m1");
  });

  it("hostFromBaseUrl снимает протокол и хвостовой слэш", () => {
    expect(hostFromBaseUrl("https://matrix.pocketnet.app")).toBe("matrix.pocketnet.app");
    expect(hostFromBaseUrl("https://matrix.pocketnet.app/")).toBe("matrix.pocketnet.app");
  });
});

/** Build a SyncWatchdog with controllable clock/timers/online for tests. */
function makeWatchdog(
  overrides: Partial<SyncWatchdogDeps> = {},
  config?: { maxConsecutiveErrors?: number; staleTimeoutMs?: number; maxConsecutiveFailovers?: number },
) {
  const onFailover = vi.fn();
  let online = true;
  let nowMs = 0;
  const timers = new Map<number, { cb: () => void; due: number }>();
  let seq = 1;

  const deps: SyncWatchdogDeps = {
    onFailover,
    isOnline: () => online,
    setTimer: (cb, ms) => {
      const id = seq++;
      timers.set(id, { cb, due: nowMs + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number);
    },
    ...overrides,
  };

  const wd = new SyncWatchdog(deps, {
    maxConsecutiveErrors: config?.maxConsecutiveErrors ?? 4,
    staleTimeoutMs: config?.staleTimeoutMs ?? 45_000,
    maxConsecutiveFailovers: config?.maxConsecutiveFailovers ?? 99,
  });

  return {
    wd,
    onFailover,
    setOnline: (v: boolean) => {
      online = v;
    },
    advance: (ms: number) => {
      nowMs += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.due <= nowMs) {
          timers.delete(id);
          t.cb();
        }
      }
    },
  };
}

describe("SyncWatchdog — consecutive ERROR failover", () => {
  it("после N подряд ERROR (online) → onFailover", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 4 });
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    expect(onFailover).not.toHaveBeenCalled();
    wd.notifySync("ERROR"); // 4th
    expect(onFailover).toHaveBeenCalledTimes(1);
  });

  it("offline → НЕ переключается даже после N ERROR (A5 regression guard)", () => {
    const { wd, onFailover, setOnline } = makeWatchdog({}, { maxConsecutiveErrors: 2 });
    setOnline(false);
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("PREPARED сбрасывает счётчик подряд-ошибок", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 3 });
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    wd.notifySync("PREPARED"); // reset
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("одного failover на эпизод (firing-guard) — повторные ERROR не дёргают onFailover", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 1 });
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    wd.notifySync("ERROR");
    expect(onFailover).toHaveBeenCalledTimes(1);
  });
});

describe("SyncWatchdog — stale-timer failover", () => {
  it("нет PREPARED/SYNCING > порога при online → triggert failover", () => {
    const { wd, onFailover, advance } = makeWatchdog({}, { maxConsecutiveErrors: 999, staleTimeoutMs: 45_000 });
    wd.notifySync("RECONNECTING");
    expect(onFailover).not.toHaveBeenCalled();
    advance(45_000);
    expect(onFailover).toHaveBeenCalledTimes(1);
  });

  it("stale-дедлайн НЕ продлевается на каждой ошибке (anchor к первой)", () => {
    const { wd, onFailover, advance } = makeWatchdog({}, { maxConsecutiveErrors: 999, staleTimeoutMs: 30_000 });
    wd.notifySync("RECONNECTING"); // arms at t=0, due t=30000
    advance(20_000);
    wd.notifySync("RECONNECTING"); // must NOT push the deadline out
    advance(10_000); // total 30000 → fire
    expect(onFailover).toHaveBeenCalledTimes(1);
  });

  it("PREPARED до истечения порога → failover не происходит", () => {
    const { wd, onFailover, advance } = makeWatchdog({}, { maxConsecutiveErrors: 999, staleTimeoutMs: 30_000 });
    wd.notifySync("RECONNECTING");
    advance(20_000);
    wd.notifySync("PREPARED");
    advance(20_000);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("stop() гасит таймер — failover не срабатывает после teardown", () => {
    const { wd, onFailover, advance } = makeWatchdog({}, { maxConsecutiveErrors: 999, staleTimeoutMs: 30_000 });
    wd.notifySync("RECONNECTING");
    wd.stop();
    advance(60_000);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("reset() снимает firing-guard — следующий эпизод может снова failover", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 1 });
    wd.notifySync("ERROR");
    expect(onFailover).toHaveBeenCalledTimes(1);
    wd.reset();
    wd.notifySync("ERROR");
    expect(onFailover).toHaveBeenCalledTimes(2);
  });
});

describe("SyncWatchdog — STOPPED нейтрален + failover-cap (review M1/L2)", () => {
  it("STOPPED не вооружает stale-таймер и не вызывает failover (intentional teardown)", () => {
    const { wd, onFailover, advance } = makeWatchdog({}, { maxConsecutiveErrors: 999, staleTimeoutMs: 30_000 });
    wd.notifySync("STOPPED");
    advance(60_000);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("перестаёт ротацию после исчерпания failover-бюджета (нет teardown+login навечно)", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 1, maxConsecutiveFailovers: 2 });
    // Each episode: ERROR triggers failover, then recreate calls reset().
    wd.notifySync("ERROR"); wd.reset(); // failover 1
    wd.notifySync("ERROR"); wd.reset(); // failover 2
    wd.notifySync("ERROR"); wd.reset(); // budget spent → no failover 3
    expect(onFailover).toHaveBeenCalledTimes(2);
  });

  it("здоровый sync восстанавливает failover-бюджет", () => {
    const { wd, onFailover } = makeWatchdog({}, { maxConsecutiveErrors: 1, maxConsecutiveFailovers: 1 });
    wd.notifySync("ERROR"); wd.reset(); // failover 1 (budget spent)
    wd.notifySync("ERROR"); wd.reset(); // blocked
    expect(onFailover).toHaveBeenCalledTimes(1);
    wd.notifySync("PREPARED"); // healthy → resets budget
    wd.notifySync("ERROR"); wd.reset(); // failover allowed again
    expect(onFailover).toHaveBeenCalledTimes(2);
  });
});

/**
 * Source-level wiring guards for matrix-client.ts. The service wires the SDK
 * directly (IndexedDB/crypto/sync filters) so behavioral mocking is too costly;
 * these assertions make sure the failover wiring cannot silently regress.
 */
describe("matrix-client.ts wiring", () => {
  const source = readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

  it("импортирует failover-примитивы из sync-failover", () => {
    expect(source).toMatch(/from\s+["']\.\/sync-failover["']/);
    expect(source).toContain("pickLiveMatrixHost");
    expect(source).toContain("nextMatrixHost");
    expect(source).toContain("SyncWatchdog");
  });

  it("ping-and-pick живого homeserver в init() до подключения", () => {
    expect(source).toMatch(/pingServers\s*\(/);
    expect(source).toContain("pickLiveMatrixHost");
  });

  it("на ERROR использует backoff вместо тугого retryImmediately", () => {
    // retryImmediately must no longer be called directly in the sync listener;
    // it is now scheduled behind a backoff timer.
    expect(source).toMatch(/scheduleErrorRetry|errorRetry/);
  });

  it("watchdog получает каждое sync-состояние и пересоздаёт клиента на mirror", () => {
    expect(source).toMatch(/watchdog[^\n]*notifySync/);
    expect(source).toMatch(/recreateOnNextMirror|nextMatrixHost/);
  });

  it("destroy() останавливает watchdog (без утечки при logout)", () => {
    const destroyIdx = source.indexOf("destroy() {");
    expect(destroyIdx).toBeGreaterThan(-1);
    const destroyBody = source.slice(destroyIdx, destroyIdx + 500);
    expect(destroyBody).toMatch(/watchdog[^\n]*\.stop\(\)/);
  });

  it("recreate уступает in-flight client-creation (building-guard, review H1)", () => {
    expect(source).toMatch(/this\.building/);
    const recreateIdx = source.indexOf("recreateOnNextMirror");
    const recreateBody = source.slice(recreateIdx, recreateIdx + 400);
    expect(recreateBody).toMatch(/if\s*\(\s*this\.failoverActive\s*\|\|\s*this\.building\s*\)\s*return/);
  });

  it("failed mirror recreate does not leave the service without a client", () => {
    const recreateIdx = source.indexOf("recreateOnNextMirror");
    expect(recreateIdx).toBeGreaterThan(-1);
    const recreateBody = source.slice(recreateIdx, recreateIdx + 2200);
    expect(recreateBody).toContain("failover recovery rebuilt client on original host");
    expect(recreateBody).toContain("this.baseUrl = `https://${current}`");
    expect(recreateBody).toContain('this.client = null');
    expect(recreateBody).toContain("const fallbackClient = await this.getClient()");
  });

  it("pingServers пропускается под Tor (review M2)", () => {
    const pingIdx = source.indexOf("async pingServers(");
    const pingBody = source.slice(pingIdx, pingIdx + 400);
    expect(pingBody).toMatch(/torProxyUrl/);
  });
});
