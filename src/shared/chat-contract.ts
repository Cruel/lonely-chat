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

import type { InferenceMode, SessionPreferences, SessionSnapshot } from './session-contract';
import type { VideoFrame, VideoSource } from './video-contract';
import type { AudioSegment, AudioStatus } from './audio-contract';
import type { ModelDiscoveryResult, ModelRole } from './model-contract';
import type { ModelInstallRequest, ModelManagerSnapshot } from './model-install-contract';

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
  'models:snapshot': ModelManagerSnapshot;
  'models:install': ModelManagerSnapshot;
  'models:cancel': void;
  'models:activate': ModelManagerSnapshot;
  'models:remove': ModelManagerSnapshot;
  'models:choose-directory': ModelManagerSnapshot;
  'video:list-displays': VideoSource[];
  'video:select': void;
  'video:frame': void;
  'audio:status': AudioStatus;
  'audio:start': AudioStatus;
  'audio:stop': AudioStatus;
  'audio:segment': void;
}

/** Method arguments are also a shared contract, not renderer-defined strings. */
export interface DesktopArguments {
  'chat:snapshot': [];
  'chat:sample': [];
  'overlay:url': [];
  'session:snapshot': [];
  'session:start': [manualContext: string, mode?: InferenceMode];
  'session:stop': [];
  'preferences:get': [];
  'preferences:set': [preferences: SessionPreferences];
  'models:discover': [source: string];
  'models:snapshot': [];
  'models:install': [selection: ModelInstallRequest];
  'models:cancel': [];
  'models:activate': [role: ModelRole, id: string | null];
  'models:remove': [id: string];
  'models:choose-directory': [];
  'video:list-displays': [];
  'video:select': [sourceId: string | null];
  'video:frame': [frame: VideoFrame];
  'audio:status': [];
  'audio:start': [sourceId: string, label: string, captureId: string];
  'audio:stop': [captureId: string];
  'audio:segment': [segment: AudioSegment, captureId: string];
}

export interface DesktopAPI {
  getChatSnapshot(): Promise<ChatSnapshot>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  publishSample(): Promise<void>;
  getOverlayUrl(): Promise<string>;
  getSessionSnapshot(): Promise<SessionSnapshot>;
  onSessionChange(listener: (status: SessionSnapshot) => void): () => void;
  startSession(manualContext: string, mode?: InferenceMode): Promise<SessionSnapshot>;
  stopSession(): Promise<SessionSnapshot>;
  getPreferences(): Promise<SessionPreferences>;
  setPreferences(preferences: SessionPreferences): Promise<SessionPreferences>;
  discoverModels(source: string): Promise<ModelDiscoveryResult>;
  getModelsSnapshot(): Promise<ModelManagerSnapshot>;
  onModelsChange(listener: (snapshot: ModelManagerSnapshot) => void): () => void;
  installModel(selection: ModelInstallRequest): Promise<ModelManagerSnapshot>;
  cancelModelDownload(): Promise<void>;
  activateModel(role: ModelRole, id: string | null): Promise<ModelManagerSnapshot>;
  removeModel(id: string): Promise<ModelManagerSnapshot>;
  chooseModelDirectory(): Promise<ModelManagerSnapshot>;
  listDisplaySources(): Promise<VideoSource[]>;
  selectVideoSource(sourceId: string | null): Promise<void>;
  submitVideoFrame(frame: VideoFrame): Promise<void>;
  getAudioStatus(): Promise<AudioStatus>;
  onAudioChange(listener: (snapshot: AudioStatus) => void): () => void;
  startAudio(sourceId: string, label: string, captureId: string): Promise<AudioStatus>;
  stopAudio(captureId: string): Promise<AudioStatus>;
  submitAudioSegment(segment: AudioSegment, captureId: string): Promise<void>;
}
