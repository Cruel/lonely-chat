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

import type { SessionPreferences, SessionSnapshot } from './session-contract';
import type { ModelDiscoveryResult } from './model-contract';

/** IPC return contract: renderer methods and main handlers share the same mapped channels. */
export interface DesktopInvocations {
  'chat:snapshot': ChatSnapshot;
  'chat:sample': void;
  'overlay:url': string;
  'session:snapshot': SessionSnapshot;
  'session:start': SessionSnapshot;
  'session:stop': SessionSnapshot;
  'preferences:get': SessionPreferences;
  'preferences:set': SessionPreferences;
  'models:discover': ModelDiscoveryResult;
}

/** Method arguments are also a shared contract, not renderer-defined strings. */
export interface DesktopArguments {
  'chat:snapshot': [];
  'chat:sample': [];
  'overlay:url': [];
  'session:snapshot': [];
  'session:start': [manualContext: string];
  'session:stop': [];
  'preferences:get': [];
  'preferences:set': [preferences: SessionPreferences];
  'models:discover': [source: string];
}

export interface DesktopAPI {
  getChatSnapshot(): Promise<ChatSnapshot>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  publishSample(): Promise<void>;
  getOverlayUrl(): Promise<string>;
  getSessionSnapshot(): Promise<SessionSnapshot>;
  onSessionChange(listener: (status: SessionSnapshot) => void): () => void;
  startSession(manualContext: string): Promise<SessionSnapshot>;
  stopSession(): Promise<SessionSnapshot>;
  getPreferences(): Promise<SessionPreferences>;
  setPreferences(preferences: SessionPreferences): Promise<SessionPreferences>;
  discoverModels(source: string): Promise<ModelDiscoveryResult>;
}
