import { ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { PostComment } from "@/app/providers/initializers";

export interface CommentPreviewAuthor {
  name: string;
  image: string;
}

/**
 * The comment a shared link points to, plus the comment it answers — what
 * Bastyon's papi.comment shows for `…?s={post}&commentid={id}` (its comments
 * widget filters the post's comments down to commentid and its parent).
 * Comments are loaded by id: getcomments(['', '', address, ids]).
 */
export function useCommentPreview(commentId: string) {
  const authStore = useAuthStore();
  const comment = ref<PostComment | null>(null);
  const replyTo = ref<PostComment | null>(null);
  const authors = ref<Record<string, CommentPreviewAuthor>>({});
  const loading = ref(false);
  const notFound = ref(false);

  async function loadAuthors(list: PostComment[]): Promise<void> {
    const addresses = [...new Set(list.map((c) => c.address).filter(Boolean))];
    if (!addresses.length) return;
    try {
      await authStore.loadUsersInfo(addresses);
    } catch (e) {
      console.warn("[useCommentPreview] loadUsersInfo failed:", e);
    }
    const next: Record<string, CommentPreviewAuthor> = { ...authors.value };
    for (const addr of addresses) {
      const user = authStore.getBastyonUserData(addr);
      next[addr] = { name: user?.name || addr.slice(0, 10), image: user?.image || "" };
    }
    authors.value = next;
  }

  async function load(): Promise<void> {
    if (!commentId) return;
    loading.value = true;
    notFound.value = false;
    try {
      const [found] = (await authStore.loadCommentsByIds([commentId])).filter((c) => c.id === commentId);
      if (!found) {
        notFound.value = true;
        return;
      }
      comment.value = found;

      // answerid — the comment it replies to; parentid — the thread root.
      const contextId = found.answerid || found.parentid;
      const loaded = [found];
      if (contextId && contextId !== found.id) {
        const [parent] = (await authStore.loadCommentsByIds([contextId])).filter((c) => c.id === contextId);
        if (parent && !parent.deleted) {
          replyTo.value = parent;
          loaded.push(parent);
        }
      }
      await loadAuthors(loaded);
    } catch (e) {
      console.error("[useCommentPreview] load failed:", e);
      notFound.value = true;
    } finally {
      loading.value = false;
    }
  }

  return { comment, replyTo, authors, loading, notFound, load };
}
