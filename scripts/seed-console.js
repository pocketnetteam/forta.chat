/**
 * Browser Console Data Seeder
 *
 * Copy-paste this ENTIRE file into Chrome DevTools console
 * while the chat app is open and logged in.
 *
 * Then run:
 *   await seedHeavyState()           // baseline (invites at bottom)
 *   await seedHeavyState(null, true) // with pollution (invites jump to top)
 *   await cleanSeedData()            // cleanup
 */

// ── Config ──
const ACTIVE_CHATS = 1000;
const OLD_INVITES = 100000;
const BATCH = 5000;
const NOW = Date.now();
const DAY = 86400000;
const YEAR = 365 * DAY;
const DB_PREFIX = "bastyon-chat-";

const hex = (n) => Array.from({length: n}, () => "0123456789abcdef"[Math.random()*16|0]).join("");
const roomId = (i) => `!seed_${i}_${hex(8)}:pocketnet.app`;
const addr = () => hex(34);

// ── Room factories ──

function activeChat(i) {
  const ts = NOW - (Math.random() * 30 * DAY | 0);
  const other = addr();
  return {
    id: roomId(i), name: `Chat ${i}`, isGroup: i%5===0, members: [addr(), other],
    membership: "join", unreadCount: Math.random()*10|0,
    lastReadInboundTs: ts-DAY, lastReadOutboundTs: ts-2*DAY, topic: "",
    updatedAt: ts,
    lastMessagePreview: `Msg ${i}: ${hex(16)}`,
    lastMessageTimestamp: ts,
    lastMessageSenderId: other,
    lastMessageType: "text",
    lastMessageEventId: `$seed_${i}_${hex(8)}`,
    lastMessageReaction: null, lastMessageLocalStatus: "synced",
    isDeleted: false, deletedAt: null, deleteReason: null,
    syncedAt: NOW, hasMoreHistory: true,
  };
}

function oldInvite(i, pollute) {
  const inviteTs = NOW - 2*YEAR - (Math.random()*YEAR|0);
  const room = {
    id: roomId(ACTIVE_CHATS + i), name: `Invite ${i}`, isGroup: true,
    members: [addr(), addr()], membership: "invite", unreadCount: 0,
    lastReadInboundTs: 0, lastReadOutboundTs: 0, topic: "",
    updatedAt: i%2===0 ? NOW : inviteTs,  // 50% get Date.now() updatedAt pollution
    // Sort key fields — should be undefined for invites
    lastMessagePreview: undefined,
    lastMessageTimestamp: undefined,
    lastMessageSenderId: undefined,
    lastMessageType: undefined,
    lastMessageEventId: undefined,
    lastMessageReaction: null, lastMessageLocalStatus: undefined,
    isDeleted: false, deletedAt: null, deleteReason: null,
    syncedAt: NOW, hasMoreHistory: true,
  };
  // With pollution: 10% of invites get fresh lastMessageTimestamp
  if (pollute && i % 10 === 0) {
    room.lastMessageTimestamp = NOW - (Math.random() * DAY | 0);
    room.lastMessagePreview = "[encrypted]";
  }
  return room;
}

// ── DB helpers ──

async function getDbName() {
  const dbs = await indexedDB.databases();
  const db = dbs.find(d => d.name?.startsWith(DB_PREFIX));
  if (!db?.name) throw new Error("Chat DB not found. Is the app logged in?");
  console.log(`[Seeder] Found DB: ${db.name}`);
  return db.name;
}

async function writeBatch(dbName, rooms) {
  const db = await new Promise((ok, fail) => {
    const r = indexedDB.open(dbName);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  const tx = db.transaction("rooms", "readwrite");
  const store = tx.objectStore("rooms");
  for (const room of rooms) store.put(room);
  await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = () => fail(tx.error); });
  db.close();
}

// ── Main ──

async function seedHeavyState(userId, withPollution = false) {
  const dbName = userId ? `${DB_PREFIX}${userId}` : await getDbName();
  const total = ACTIVE_CHATS + OLD_INVITES;
  let done = 0;

  console.log(`[Seeder] Generating ${ACTIVE_CHATS} active chats + ${OLD_INVITES} invites (pollution=${withPollution})`);
  console.time("[Seeder] Total time");

  // Active chats
  for (let i = 0; i < ACTIVE_CHATS; i += BATCH) {
    const batch = Array.from({length: Math.min(BATCH, ACTIVE_CHATS-i)}, (_, j) => activeChat(i+j));
    await writeBatch(dbName, batch);
    done += batch.length;
    console.log(`[Seeder] ${done}/${total} (${(done/total*100).toFixed(1)}%)`);
  }

  // Old invites
  for (let i = 0; i < OLD_INVITES; i += BATCH) {
    const batch = Array.from({length: Math.min(BATCH, OLD_INVITES-i)}, (_, j) => oldInvite(i+j, withPollution));
    await writeBatch(dbName, batch);
    done += batch.length;
    console.log(`[Seeder] ${done}/${total} (${(done/total*100).toFixed(1)}%)`);
    await new Promise(r => setTimeout(r, 10)); // yield
  }

  console.timeEnd("[Seeder] Total time");
  console.log(`[Seeder] ✅ Done! Reload the app now.`);
}

async function cleanSeedData(userId) {
  const dbName = userId ? `${DB_PREFIX}${userId}` : await getDbName();
  const db = await new Promise((ok, fail) => {
    const r = indexedDB.open(dbName);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  const tx = db.transaction("rooms", "readwrite");
  const store = tx.objectStore("rooms");
  let del = 0;
  await new Promise((ok, fail) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return ok();
      if (typeof c.value.id === "string" && c.value.id.includes("seed_")) { c.delete(); del++; }
      c.continue();
    };
    req.onerror = () => fail(req.error);
  });
  db.close();
  console.log(`[Seeder] Cleaned ${del} seeded rooms. Reload the app.`);
}

console.log("[Seeder] Ready. Run: await seedHeavyState() or await seedHeavyState(null, true)");
