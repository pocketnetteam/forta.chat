import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { MessageType } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { cleanMatrixIds, resolveSystemText } from "@/entities/chat/lib/chat-helpers";
import { isEncryptedPlaceholder } from "./is-encrypted-placeholder";

/**
 * Format a message for preview display (chat list, search results).
 * Handles deleted, media, system, call messages + text cleanup.
 */
export function useFormatPreview() {
  const chatStore = useChatStore();
  const authStore = useAuthStore();
  const { t } = useI18n();

  const formatPreview = (msg: Message | undefined, room: ChatRoom): string => {
    if (!msg) return t("contactList.noMessages");
    if (isEncryptedPlaceholder(msg.content)) return "";
    if (msg.deleted || (!msg.content && msg.type === MessageType.text && !msg.fileInfo)) {
      return `🚫 ${t("message.deleted")}`;
    }
    let preview: string;
    switch (msg.type) {
      case MessageType.image:
        preview = msg.content && msg.content !== "[photo]" ? `📷 ${msg.content}` : "📷 " + t("message.photo");
        break;
      case MessageType.video:
        preview = msg.content && msg.content !== "[video]" ? `🎬 ${msg.content}` : "🎬 " + t("message.video");
        break;
      case MessageType.audio:
        preview = msg.content && msg.content !== "[voice message]" ? `🎤 ${msg.content}` : "🎤 " + t("message.voiceMessage");
        break;
      case MessageType.videoCircle:
        preview = msg.content && msg.content !== "[video message]" ? `🎬 ${msg.content}` : "🎬 " + t("message.videoMessage");
        break;
      case MessageType.file:
        preview = `📎 ${msg.content || t("message.file")}`;
        break;
      case MessageType.system: {
        let sysText: string;
        if (msg.systemMeta?.template) {
          sysText = resolveSystemText(
            msg.systemMeta.template,
            msg.systemMeta.senderAddr,
            msg.systemMeta.targetAddr,
            (addr) => chatStore.getDisplayName(addr),
            t,
            msg.systemMeta.extra,
          );
        } else {
          sysText = cleanMatrixIds(msg.content);
        }
        // Guard: never show hex/address strings in chat list preview
        if (/[a-f0-9]{16,}/i.test(sysText)) {
          sysText = t("system.unknownEvent");
        }
        if (msg.callInfo) {
          const icon = msg.callInfo.callType === "video" ? "📹" : "📞";
          return `${icon} ${sysText}`;
        }
        return sysText;
      }
      default:
        preview = msg.content || "";
    }
    preview = stripMentionAddresses(preview);
    preview = stripBastyonLinks(preview);
    preview = cleanMatrixIds(preview);

    if (room.isGroup && msg.senderId) {
      const myAddr = authStore.address ?? "";
      const senderName = msg.senderId === myAddr ? t("contactList.you") : chatStore.getDisplayName(msg.senderId);
      preview = `${senderName}: ${preview}`;
    }
    return preview;
  };

  return { formatPreview };
}
