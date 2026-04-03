import { reactive } from "vue";

export interface DemoteOptions {
  address: string;
  accessToken: string;
  homeserverUrl: string;
  syncToken: string;
}

interface Poller {
  address: string;
  accessToken: string;
  homeserverUrl: string;
  syncToken: string;
  timerId: ReturnType<typeof setTimeout> | null;
}

const FOREGROUND_INTERVAL = 30_000;
const BACKGROUND_INTERVAL = 300_000;

const SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { limit: 0 },
    state: { lazy_load_members: true, types: [] },
    ephemeral: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

export class BackgroundSyncManager {
  private pollers = new Map<string, Poller>();
  private unreadCounts = reactive<Record<string, number>>({});
  private foreground = true;

  // --- Lifecycle ---

  demote(opts: DemoteOptions): void {
    // Stop existing poller for this address if any
    this.stop(opts.address);

    const poller: Poller = {
      address: opts.address,
      accessToken: opts.accessToken,
      homeserverUrl: opts.homeserverUrl,
      syncToken: opts.syncToken,
      timerId: null,
    };

    this.pollers.set(opts.address, poller);
    this.scheduleNext(poller);
  }

  promote(address: string): void {
    this.stop(address);
  }

  stop(address: string): void {
    const poller = this.pollers.get(address);
    if (!poller) return;

    if (poller.timerId !== null) {
      clearTimeout(poller.timerId);
      poller.timerId = null;
    }
    this.pollers.delete(address);
    delete this.unreadCounts[address];
  }

  stopAll(): void {
    for (const address of [...this.pollers.keys()]) {
      this.stop(address);
    }
  }

  // --- Data ---

  getUnreadCount(address: string): number {
    return this.unreadCounts[address] ?? 0;
  }

  getAllUnreadCounts(): Record<string, number> {
    return { ...this.unreadCounts };
  }

  get reactiveUnreadCounts(): Record<string, number> {
    return this.unreadCounts;
  }

  // --- App state ---

  setAppState(foreground: boolean): void {
    this.foreground = foreground;
  }

  // --- Internal ---

  private get interval(): number {
    return this.foreground ? FOREGROUND_INTERVAL : BACKGROUND_INTERVAL;
  }

  private scheduleNext(poller: Poller): void {
    poller.timerId = setTimeout(() => {
      void this.poll(poller);
    }, this.interval);
  }

  private async poll(poller: Poller): Promise<void> {
    try {
      const url = `${poller.homeserverUrl}/_matrix/client/v3/sync?timeout=0&since=${encodeURIComponent(poller.syncToken)}&filter=${encodeURIComponent(SYNC_FILTER)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${poller.accessToken}` },
      });

      if (!res.ok) {
        console.warn(
          `[BackgroundSync] ${poller.address}: HTTP ${res.status}`,
        );
      } else {
        const data = await res.json();

        let total = 0;
        const joinedRooms = data?.rooms?.join;
        if (joinedRooms && typeof joinedRooms === "object") {
          for (const roomData of Object.values(joinedRooms)) {
            const count = (roomData as any)?.unread_notifications
              ?.notification_count;
            if (typeof count === "number") total += count;
          }
        }

        this.unreadCounts[poller.address] = total;

        if (data?.next_batch) {
          poller.syncToken = data.next_batch;
        }
      }
    } catch (err) {
      console.warn(`[BackgroundSync] ${poller.address}: fetch error`, err);
    }

    // Schedule next poll only if poller is still active
    if (this.pollers.has(poller.address)) {
      this.scheduleNext(poller);
    }
  }
}
