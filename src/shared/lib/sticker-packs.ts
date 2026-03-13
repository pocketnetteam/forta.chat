import { ref, shallowRef, type Ref, type ShallowRef } from "vue";

export interface Sticker {
  id: string;
  url: string;
  packId: string;
}

export interface StickerPack {
  id: string;
  name: string;
  iconUrl: string;
  stickers: Sticker[];
}

interface ManifestPack {
  id: string;
  name: string;
  icon: string;
  stickers: string[];
}

interface Manifest {
  packs: ManifestPack[];
}

let cachedPacks: StickerPack[] | null = null;

export async function loadStickerPacks(): Promise<StickerPack[]> {
  if (cachedPacks) return cachedPacks;

  const res = await fetch("/stickers/manifest.json");
  if (!res.ok) throw new Error(`Failed to load sticker manifest: ${res.status}`);

  const manifest: Manifest = await res.json();

  cachedPacks = manifest.packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    iconUrl: `/stickers/${pack.id}/${pack.icon}`,
    stickers: pack.stickers.map((filename) => ({
      id: `${pack.id}/${filename}`,
      url: `/stickers/${pack.id}/${filename}`,
      packId: pack.id,
    })),
  }));

  return cachedPacks;
}

export function useStickerPacks(): {
  packs: ShallowRef<StickerPack[]>;
  loaded: Ref<boolean>;
  loadStickerPacks: () => Promise<void>;
} {
  const packs = shallowRef<StickerPack[]>([]);
  const loaded = ref(false);

  const load = async () => {
    try {
      packs.value = await loadStickerPacks();
    } catch (e) {
      console.error("Failed to load sticker packs:", e);
      packs.value = [];
    } finally {
      loaded.value = true;
    }
  };

  return { packs, loaded, loadStickerPacks: load };
}
