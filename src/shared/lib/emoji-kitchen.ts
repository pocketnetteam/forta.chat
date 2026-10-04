/**
 * Emoji Kitchen lookup wrapper.
 *
 * Uses pre-extracted recipe data from emoji-kitchen-mart to resolve
 * Google Emoji Kitchen combination images.
 */

export interface KitchenCombo {
  emoji: string;
  imageUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers: convert between native emoji strings and unified hex codes
// ---------------------------------------------------------------------------

/** Native emoji char(s) → lowercase dash-separated hex code (e.g. "1f600") */
function emojiToUnified(emoji: string): string {
  const codePoints: string[] = [];
  for (const cp of emoji) {
    const hex = cp.codePointAt(0)!.toString(16).toLowerCase();
    // skip variation selector U+FE0F – the recipe dataset omits it
    if (hex === "fe0f") continue;
    codePoints.push(hex);
  }
  return codePoints.join("-");
}

/** Lowercase unified hex code → native emoji string */
function unifiedToEmoji(unified: string): string {
  return unified
    .split("-")
    .map((h) => String.fromCodePoint(parseInt(h, 16)))
    .join("");
}

// ---------------------------------------------------------------------------
// Recipe dataset – lazily loaded from pre-extracted JSON
// ---------------------------------------------------------------------------

type RecipeRow = [string, string, string]; // [leftUnified, rightUnified, date]
type RecipeMap = Record<string, RecipeRow[]>;

let _recipes: RecipeMap | null = null;
let _loading: Promise<RecipeMap> | null = null;

async function ensureRecipes(): Promise<RecipeMap> {
  if (_recipes) return _recipes;
  if (_loading) return _loading;

  _loading = import("./emoji-kitchen-data.json").then((mod) => {
    _recipes = (mod.default ?? mod) as unknown as RecipeMap;
    return _recipes;
  }).catch(() => {
    _recipes = {};
    return _recipes;
  });

  return _loading;
}

/**
 * Load the recipe dataset (~2.5 MB parsed). Called when the kitchen bar
 * mounts, not on import: EmojiPicker is in the startup graph, so an eager
 * kickoff parsed the whole dataset on every cold start.
 */
export async function loadKitchenRecipes(): Promise<void> {
  await ensureRecipes();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const KITCHEN_ROOT = "https://www.gstatic.com/android/keyboard/emojikitchen";

function toUrlCode(unified: string): string {
  return unified
    .split("-")
    .map((p) => `u${p.toLowerCase()}`)
    .join("-");
}

function buildImageUrl(
  leftUnified: string,
  rightUnified: string,
  date: string,
): string {
  const left = toUrlCode(leftUnified);
  const right = toUrlCode(rightUnified);
  return `${KITCHEN_ROOT}/${date}/${left}/${left}_${right}.png`;
}

/**
 * Return all available Emoji Kitchen combinations for a given emoji.
 * Each result contains the partner emoji (native) and the combination image URL.
 */
export function getKitchenCombos(emoji: string): KitchenCombo[] {
  const recipes = _recipes ?? {};
  const unified = emojiToUnified(emoji);

  const combos: KitchenCombo[] = [];
  const seen = new Set<string>();

  // Recipes are keyed by one of the two emoji codes. We need to check
  // both the key matching our emoji AND entries inside other keys that
  // reference our emoji.

  // 1. Direct key lookup
  const directRows = recipes[unified];
  if (directRows) {
    for (const [left, right, date] of directRows) {
      const partner = left === unified ? right : left;
      if (seen.has(partner)) continue;
      seen.add(partner);
      combos.push({
        emoji: unifiedToEmoji(partner),
        imageUrl: buildImageUrl(left, right, date),
      });
    }
  }

  // 2. Scan all keys for rows where our emoji appears as a partner.
  // The dataset is ~500 keys so this is fast enough for interactive use.
  for (const [key, rows] of Object.entries(recipes)) {
    if (key === unified) continue;
    for (const [left, right, date] of rows) {
      const partnerOf =
        left === unified ? right : right === unified ? left : null;
      if (!partnerOf || seen.has(partnerOf)) continue;
      seen.add(partnerOf);
      combos.push({
        emoji: unifiedToEmoji(partnerOf),
        imageUrl: buildImageUrl(left, right, date),
      });
    }
  }

  return combos;
}

/**
 * Return the Emoji Kitchen combination image URL for two specific emojis,
 * or `null` if no combination exists.
 */
export function getKitchenCombo(
  emoji1: string,
  emoji2: string,
): string | null {
  const recipes = _recipes ?? {};
  const u1 = emojiToUnified(emoji1);
  const u2 = emojiToUnified(emoji2);

  // Check both possible key lookups
  for (const key of [u1, u2]) {
    const rows = recipes[key];
    if (!rows) continue;
    // Take the latest dated recipe (last after sort)
    let best: RecipeRow | null = null;
    for (const row of rows) {
      const [left, right] = row;
      if (
        (left === u1 && right === u2) ||
        (left === u2 && right === u1)
      ) {
        if (!best || row[2] > best[2]) best = row;
      }
    }
    if (best) {
      return buildImageUrl(best[0], best[1], best[2]);
    }
  }

  return null;
}
