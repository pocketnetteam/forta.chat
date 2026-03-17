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
  /** Room topic / description (from m.room.topic state event) */
  topic?: string;
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
  /** True for video circle (video note) messages */
  videoNote?: boolean;
  /** Thumbnail URL for video circles */
  thumbnailUrl?: string;
}

export interface ReplyTo {
  id: string;
  senderId: string;
  content: string;
  type?: MessageType;
}

/** Open Graph metadata for URL link previews */
export interface LinkPreview {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
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
  /** Poll metadata — present when type === poll */
  pollInfo?: PollInfo;
  /** Transfer metadata — present when type === transfer */
  transferInfo?: TransferInfo;
  /** URL link preview metadata (Open Graph) */
  linkPreview?: LinkPreview;
  /** Whether this message has been deleted/redacted */
  deleted?: boolean;
  /** For system messages: template + addresses for dynamic name resolution at render time */
  systemMeta?: {
    template: string;       // e.g. "{sender} joined the chat"
    senderAddr: string;     // raw Bastyon address of the actor
    targetAddr?: string;    // raw Bastyon address of the target (for add/remove/invite)
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
  system = "system",
  poll = "poll",
  transfer = "transfer",
  videoCircle = "videoCircle",
}

export interface PollInfo {
  question: string;
  options: Array<{ id: string; text: string }>;
  /** optionId → list of voter addresses */
  votes: Record<string, string[]>;
  /** The option ID the current user voted for */
  myVote?: string;
  /** Whether the poll has been ended */
  ended?: boolean;
  /** Address of the user who ended the poll */
  endedBy?: string;
}

export interface TransferInfo {
  txId: string;
  amount: number;
  /** Sender blockchain address */
  from: string;
  /** Receiver blockchain address */
  to: string;
  message?: string;
}
