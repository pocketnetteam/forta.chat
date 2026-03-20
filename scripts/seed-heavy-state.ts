/**
 * Heavy State Data Seeder
 *
 * Generates 1,000 active chats + 100,000 old invites in Dexie (IndexedDB)
 * to reproduce the "old invites floating to top" bug.
 *
 * Usage:
 *   1. Build: npx tsx scripts/seed-heavy-state.ts  (or paste in browser console after adaptation)
 *   2. For browser console: open the app, run seedHeavyState() from DevTools
 *   3. The script connects to the existing Dexie database for the logged-in user
 *
 * This file is meant to be loaded as an ES module in the browser context.
 * Copy-paste the seedHeavyState() function body into DevTools console.
 */

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  /** Number of active chats with real messages */
  ACTIVE_CHATS: 1_000,
  /** Number of old invites (2-3 years old) */
  OLD_INVITES: 100_000,
  /** Batch size for Dexie bulkPut (larger = faster, but more memory) */
  BATCH_SIZE: 5_000,
  /** Simulated user ID for DB name */
  DB_NAME_PREFIX: "bastyon-chat-",
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function randomHex(len: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * 16)];
  return result;
}

function randomRoomId(index: number): string {
  return `!seed_${index}_${randomHex(8)}:pocketnet.app`;
}

function randomAddress(): string {
  return randomHex(34); // Bastyon address format
}

const NOW = Date.now();
const ONE_DAY = 86_400_000;
const ONE_YEAR = 365 * ONE_DAY;

// ─────────────────────────────────────────────────────────────
// Room generators
// ─────────────────────────────────────────────────────────────

interface SeedRoom {
  id: string;
  name: string;
  avatar?: string;
  isGroup: boolean;
  members: string[];
  membership: "join" | "invite";
  unreadCount: number;
  lastReadInboundTs: number;
  lastReadOutboundTs: number;
  topic: string;
  updatedAt: number;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
  lastMessageSenderId?: string;
  lastMessageType?: string;
  lastMessageEventId?: string;
  lastMessageReaction: null;
  lastMessageLocalStatus?: string;
  isDeleted: boolean;
  deletedAt: null;
  deleteReason: null;
  syncedAt: number;
  hasMoreHistory: boolean;
}

/** Generate an active chat room with a recent message */
function makeActiveChat(index: number): SeedRoom {
  // Spread messages over the last 30 days, most recent first
  const lastMsgTs = NOW - Math.floor(Math.random() * 30 * ONE_DAY);
  const otherMember = randomAddress();

  return {
    id: randomRoomId(index),
    name: `Active Chat ${index}`,
    isGroup: index % 5 === 0, // 20% are groups
    members: [randomAddress(), otherMember],
    membership: "join",
    unreadCount: Math.floor(Math.random() * 10),
    lastReadInboundTs: lastMsgTs - ONE_DAY,
    lastReadOutboundTs: lastMsgTs - 2 * ONE_DAY,
    topic: "",
    updatedAt: lastMsgTs,
    lastMessagePreview: `Message from active chat ${index}: ${randomHex(20)}`,
    lastMessageTimestamp: lastMsgTs,
    lastMessageSenderId: otherMember,
    lastMessageType: "text",
    lastMessageEventId: `$seed_msg_${index}_${randomHex(8)}`,
    lastMessageReaction: null,
    lastMessageLocalStatus: "synced",
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: NOW,
    hasMoreHistory: true,
  };
}

/** Generate an old invite room (2-3 years old) */
function makeOldInvite(index: number): SeedRoom {
  // Invite created 2-3 years ago
  const inviteTs = NOW - (2 * ONE_YEAR) - Math.floor(Math.random() * ONE_YEAR);

  return {
    id: randomRoomId(CONFIG.ACTIVE_CHATS + index),
    name: `Old Invite ${index}`,
    isGroup: true,
    members: [randomAddress(), randomAddress()],
    membership: "invite",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    topic: "",
    // ── KEY FIELDS FOR BUG REPRODUCTION ──
    // Scenario A: updatedAt = Date.now() (simulates the Date.now() fallback bug)
    // Scenario B: updatedAt = inviteTs (correct behavior)
    // Toggle between them to test both scenarios:
    updatedAt: index % 2 === 0 ? NOW : inviteTs, // 50% with Date.now() pollution
    lastMessagePreview: undefined,     // No messages in invite rooms
    lastMessageTimestamp: undefined,    // ← THIS is the sort key
    lastMessageSenderId: undefined,
    lastMessageType: undefined,
    lastMessageEventId: undefined,
    lastMessageReaction: null,
    lastMessageLocalStatus: undefined,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: NOW,  // Always Date.now() — simulates fresh sync
    hasMoreHistory: true,
  };
}

/**
 * Variant: Old invite WITH lastMessageTimestamp pollution
 * This simulates the bug where lastMessageTimestamp accidentally gets set
 * to Date.now() or syncedAt during bulk sync.
 */
function makeOldInviteWithTimestampPollution(index: number): SeedRoom {
  const invite = makeOldInvite(index);
  // Simulate timestamp pollution: lastMessageTimestamp = Date.now()
  // This is the hypothesized bug — during bulk sync, something writes
  // a fresh timestamp to lastMessageTimestamp for invite rooms
  if (index % 10 === 0) {
    // 10% of invites get polluted timestamps (they'll jump to top)
    invite.lastMessageTimestamp = NOW - Math.floor(Math.random() * ONE_DAY);
    invite.lastMessagePreview = "[encrypted]"; // Looks like a message exists
  }
  return invite;
}

// ─────────────────────────────────────────────────────────────
// Main seeder (for browser console)
// ─────────────────────────────────────────────────────────────

/**
 * Paste this function into browser DevTools console.
 * It opens the existing Dexie database and inserts seed data.
 *
 * @param userId - The logged-in user's bastyon address (check localStorage)
 * @param withPollution - If true, 10% of invites get polluted timestamps
 */
export async function seedHeavyState(
  userId?: string,
  withPollution = false,
): Promise<void> {
  // Auto-detect userId from existing Dexie databases
  if (!userId) {
    const dbs = await indexedDB.databases();
    const chatDb = dbs.find(db => db.name?.startsWith(CONFIG.DB_NAME_PREFIX));
    if (chatDb?.name) {
      userId = chatDb.name.replace(CONFIG.DB_NAME_PREFIX, "");
      console.log(`[Seeder] Auto-detected userId: ${userId}`);
    } else {
      throw new Error(
        "Could not auto-detect userId. Pass it explicitly: seedHeavyState('your-bastyon-address')"
      );
    }
  }

  const dbName = `${CONFIG.DB_NAME_PREFIX}${userId}`;
  console.log(`[Seeder] Opening database: ${dbName}`);

  // Open Dexie database directly (no import needed in console)
  // We use raw IndexedDB to avoid version conflicts with the running app
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const roomStore = db.transaction("rooms", "readwrite").objectStore("rooms");

  // Count existing rooms
  const existingCount = await new Promise<number>((resolve) => {
    const req = roomStore.count();
    req.onsuccess = () => resolve(req.result);
  });
  console.log(`[Seeder] Existing rooms in DB: ${existingCount}`);

  db.close();

  // Re-open for batch writes
  console.log(`[Seeder] Generating ${CONFIG.ACTIVE_CHATS} active chats...`);
  const activeChats = Array.from({ length: CONFIG.ACTIVE_CHATS }, (_, i) => makeActiveChat(i));

  console.log(`[Seeder] Generating ${CONFIG.OLD_INVITES} old invites (withPollution=${withPollution})...`);
  const generator = withPollution ? makeOldInviteWithTimestampPollution : makeOldInvite;

  // Insert in batches to avoid memory pressure
  const totalRooms = CONFIG.ACTIVE_CHATS + CONFIG.OLD_INVITES;
  let inserted = 0;

  const writeBatch = async (rooms: SeedRoom[]): Promise<void> => {
    const db2 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const tx = db2.transaction("rooms", "readwrite");
    const store = tx.objectStore("rooms");

    for (const room of rooms) {
      store.put(room);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db2.close();
    inserted += rooms.length;
    const pct = ((inserted / totalRooms) * 100).toFixed(1);
    console.log(`[Seeder] Progress: ${inserted}/${totalRooms} (${pct}%)`);
  };

  // Write active chats first
  for (let i = 0; i < activeChats.length; i += CONFIG.BATCH_SIZE) {
    await writeBatch(activeChats.slice(i, i + CONFIG.BATCH_SIZE));
  }

  // Write old invites in batches
  for (let i = 0; i < CONFIG.OLD_INVITES; i += CONFIG.BATCH_SIZE) {
    const batchSize = Math.min(CONFIG.BATCH_SIZE, CONFIG.OLD_INVITES - i);
    const batch = Array.from({ length: batchSize }, (_, j) => generator(i + j));
    await writeBatch(batch);
    // Yield to browser to prevent jank
    await new Promise(r => setTimeout(r, 10));
  }

  console.log(`[Seeder] ✅ Done! Inserted ${totalRooms} rooms.`);
  console.log(`[Seeder] Active chats: ${CONFIG.ACTIVE_CHATS}`);
  console.log(`[Seeder] Old invites: ${CONFIG.OLD_INVITES}`);
  console.log(`[Seeder] Reload the app to see the effect.`);
}

/**
 * Clean up: remove all seeded rooms (they all have "seed_" in the ID)
 */
export async function cleanSeedData(userId?: string): Promise<void> {
  if (!userId) {
    const dbs = await indexedDB.databases();
    const chatDb = dbs.find(db => db.name?.startsWith(CONFIG.DB_NAME_PREFIX));
    if (chatDb?.name) userId = chatDb.name.replace(CONFIG.DB_NAME_PREFIX, "");
    else throw new Error("Could not auto-detect userId");
  }

  const dbName = `${CONFIG.DB_NAME_PREFIX}${userId}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = db.transaction("rooms", "readwrite");
  const store = tx.objectStore("rooms");

  // Iterate all rooms and delete seeded ones
  const req = store.openCursor();
  let deleted = 0;

  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      const room = cursor.value;
      if (typeof room.id === "string" && room.id.includes("seed_")) {
        cursor.delete();
        deleted++;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  db.close();
  console.log(`[Seeder] Cleaned up ${deleted} seeded rooms.`);
}

// ─────────────────────────────────────────────────────────────
// Browser Console Quick-Start (copy-paste this block)
// ─────────────────────────────────────────────────────────────
/*

// === STEP 1: Seed without timestamp pollution (baseline) ===
// Paste seedHeavyState and helpers above, then:
await seedHeavyState(undefined, false);
// Reload app. Invites should be at bottom. If they ARE at top → bug is in rendering.

// === STEP 2: Seed WITH timestamp pollution (reproduce the sort bug) ===
await cleanSeedData();
await seedHeavyState(undefined, true);
// Reload app. 10% of invites will have polluted timestamps → visible bug.

// === STEP 3: Clean up ===
await cleanSeedData();

*/
