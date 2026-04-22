import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { MessageType } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { stripMentionAddresses, stripBastyonLinks } from "@/shared/lib/message-format";
import { cleanMatrixIds, resolveSystemText, isUnresolvedName } from "@/entities/chat/lib/chat-helpers";
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
    // Explicit deletion markers: the redaction flag plus the legacy English
    // literal body that the old pipeline stored for redacted text messages.
    if (msg.deleted || msg.content === "🚫 Message deleted") {
      return `🚫 ${t("message.deleted")}`;
    }
    // `"[message]"` is a generic "preview unavailable" sentinel written by
    // event-writer when getPreviewText returned empty (e.g. call events whose
    // real label lives in systemMeta/callInfo, not in content). Normalise it
    // to empty so type-specific branches produce the proper icon+label rather
    // than mislabelling the message as deleted.
    const content = msg.content === "[message]" ? "" : msg.content;
    // Empty-body text with no attachment is the legacy "deleted text" pattern.
    if (!content && msg.type === MessageType.text && !msg.fileInfo) {
      return `🚫 ${t("message.deleted")}`;
    }
    let preview: string;
    switch (msg.type) {
      case MessageType.image:
        preview = content && content !== "[photo]" ? `📷 ${content}` : "📷 " + t("message.photo");
        break;
      case MessageType.video:
        preview = content && content !== "[video]" ? `🎬 ${content}` : "🎬 " + t("message.video");
        break;
      case MessageType.audio:
        preview = content && content !== "[voice message]" ? `🎤 ${content}` : "🎤 " + t("message.voiceMessage");
        break;
      case MessageType.videoCircle:
        preview = content && content !== "[video message]" ? `🎬 ${content}` : "🎬 " + t("message.videoMessage");
        break;
      case MessageType.file:
        preview = `📎 ${content || t("message.file")}`;
        break;
      case MessageType.poll:
        preview = `📊 ${msg.pollInfo?.question || t("message.poll")}`;
        break;
      case MessageType.transfer:
        preview = `💸 ${msg.transferInfo ? `${msg.transferInfo.amount} PKOIN` : (content || t("message.transfer"))}`;
        break;
      case MessageType.system: {
        let sysText: string;
        if (msg.systemMeta?.template) {
          sysText = resolveSystemText(
            msg.systemMeta.template,
            msg.systemMeta.senderAddr,
            msg.systemMeta.targetAddr,
            (addr) => {
              const name = chatStore.getDisplayName(addr);
              return isUnresolvedName(name) ? t("common.unknownUser") : name;
            },
            t,
            msg.systemMeta.extra,
          );
        } else {
          sysText = cleanMatrixIds(content);
        }
        // Guard: never show raw hex/address/Matrix-ID strings in chat list preview
        if (/[a-f0-9]{16,}/i.test(sysText) || /![a-zA-Z0-9]+:/.test(sysText)) {
          sysText = t("system.unknownEvent");
        }
        if (msg.callInfo) {
          const icon = msg.callInfo.callType === "video" ? "📹" : "📞";
          return `${icon} ${sysText}`;
        }
        return sysText;
      }
      default:
        preview = content || "";
    }
    preview = stripMentionAddresses(preview);
    preview = stripBastyonLinks(preview);
    preview = cleanMatrixIds(preview);

    if (room.isGroup && msg.senderId) {
      const myAddr = authStore.address ?? "";
      const rawName = chatStore.getDisplayName(msg.senderId);
      const senderName = msg.senderId === myAddr
        ? t("contactList.you")
        : (isUnresolvedName(rawName) ? t("common.unknownUser") : rawName);
      preview = `${senderName}: ${preview}`;
    }
    return preview;
  };

  return { formatPreview };
}
