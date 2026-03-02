export interface ChatRoom {
  id: string;
  name: string;
  lastMessage?: Message;
  unreadCount: number;
  members: string[];
  avatar?: string;
  isGroup: boolean;
  updatedAt: number;
  /** Room membership: "join" | "invite". Invited rooms need explicit join before interaction. */
  membership?: "join" | "invite";
}

/** Metadata for file/image/video/audio messages */
export interface FileInfo {
  name: string;
  type: string;
  size: number;
  url: string;
  secrets?: {
    block: number;
    keys: string;
    v: number;
  };
  /** For images: dimensions */
  w?: number;
  h?: number;
  /** Duration in seconds (audio/video) */
  duration?: number;
  /** RMS waveform data for voice messages (~50 values 0-1) */
  waveform?: number[];
  /** Caption text attached to media */
  caption?: string;
  /** If true, caption renders above media (Telegram feature) */
  captionAbove?: boolean;
}

export interface ReplyTo {
  id: string;
  senderId: string;
  content: string;
  type?: MessageType;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  timestamp: number;
  status: MessageStatus;
  type: MessageType;
  /** File/image/video/audio metadata — present when type !== text/system */
  fileInfo?: FileInfo;
  /** Reply reference — set when this message replies to another */
  replyTo?: ReplyTo;
  /** Reactions grouped by emoji: emoji → { count, users[], myEventId? } */
  reactions?: Record<string, { count: number; users: string[]; myEventId?: string }>;
  /** Whether the message has been edited */
  edited?: boolean;
  /** Forwarded from another user */
  forwardedFrom?: { senderId: string; senderName?: string };
  /** Call event metadata for card-style rendering */
  callInfo?: {
    callType: "voice" | "video";
    missed: boolean;
    /** Call duration in seconds (0 or absent for missed/unanswered) */
    duration?: number;
  };
}

export enum MessageStatus {
  sending = "sending",
  sent = "sent",
  delivered = "delivered",
  read = "read",
  failed = "failed"
}

export enum MessageType {
  text = "text",
  image = "image",
  file = "file",
  video = "video",
  audio = "audio",
  system = "system"
}
