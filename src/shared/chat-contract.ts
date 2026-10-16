/** Only public presentation data crosses this boundary; no transcripts or configuration. */
export interface ChatMessage {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly color: string;
  readonly presentedAt: number;
}

export interface ChatSnapshot {
  readonly type: 'snapshot';
  readonly sequence: number;
  readonly messages: readonly ChatMessage[];
}

export interface ChatAppend {
  readonly type: 'append';
  readonly sequence: number;
  readonly message: ChatMessage;
}

export type ChatEvent = ChatSnapshot | ChatAppend;

/** IPC return contract: renderer methods and main handlers share the same mapped channels. */
export interface DesktopInvocations {
  'chat:snapshot': ChatSnapshot;
  'chat:sample': void;
  'overlay:url': string;
}

export interface DesktopAPI {
  getChatSnapshot(): Promise<ChatSnapshot>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  publishSample(): Promise<void>;
  getOverlayUrl(): Promise<string>;
}
