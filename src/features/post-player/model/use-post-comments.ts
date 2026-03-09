import { useAuthStore } from "@/entities/auth";
import type { PostComment } from "@/app/providers/initializers";

export function usePostComments(txid: string) {
  const authStore = useAuthStore();
  const comments = ref<PostComment[]>([]);
  const loading = ref(false);
  const submitting = ref(false);

  const load = async () => {
    loading.value = true;
    try {
      comments.value = await authStore.loadPostComments(txid);
    } finally {
      loading.value = false;
    }
  };

  const submit = async (message: string, parentId?: string) => {
    if (!message.trim() || submitting.value) return false;
    submitting.value = true;
    try {
      const ok = await authStore.submitComment(txid, message, parentId);
      if (ok) await load();
      return ok;
    } finally {
      submitting.value = false;
    }
  };

  return { comments, loading, submitting, load, submit };
}
