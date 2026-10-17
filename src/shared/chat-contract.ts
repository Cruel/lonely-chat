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
import type { FloatingChatSettings, FloatingChatSnapshot } from './floating-chat-contract';
import type { WindowStatus } from './window-status-contract';
import type { AudienceSnapshot } from './audience-contract';
import type { NativeServiceStatus } from './native-service-contract';
import type { VideoFrame, VideoSource } from './video-contract';
import type { AudioInputConfiguration, AudioSegment, AudioStatus } from './audio-contract';
import type { ModelDiscoveryResult, ModelRole } from './model-contract';
import type { ModelInstallRequest, ModelManagerSnapshot } from './model-install-contract';

/** IPC return contract: renderer methods and main handlers share the same mapped channels. */
export interface DesktopInvocations {
  'chat:snapshot': ChatSnapshot;
  'chat:sample': void;
  'overlay:url': string;
  'floating:get': FloatingChatSnapshot;
  'floating:open': FloatingChatSnapshot;
  'floating:close': FloatingChatSnapshot;
  'floating:configure': FloatingChatSnapshot;
  'window:get': WindowStatus;
  'window:set-close-to-tray': WindowStatus;
  'session:snapshot': SessionSnapshot;
  'session:start': SessionSnapshot;
  'session:stop': SessionSnapshot;
  'session:retry': SessionSnapshot;
  'native:status': NativeServiceStatus;
  'preferences:get': SessionPreferences;
  'preferences:set': SessionPreferences;
  'audience:get': AudienceSnapshot;
  'audience:regenerate': AudienceSnapshot;
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
  'audio:configuration:get': AudioInputConfiguration[];
  'audio:configuration:set': AudioInputConfiguration[];
  'audio:status': AudioStatus;
  'audio:capabilities': { windowsLoopback: boolean };
  'audio:start': AudioStatus;
  'audio:retry': AudioStatus;
  'audio:label': AudioStatus;
  'audio:disconnected': AudioStatus;
  'audio:remove': AudioStatus;
  'audio:stop': AudioStatus;
  'audio:segment': void;
}

/** Method arguments are also a shared contract, not renderer-defined strings. */
export interface DesktopArguments {
  'chat:snapshot': [];
  'chat:sample': [];
  'overlay:url': [];
  'floating:get': [];
  'floating:open': [];
  'floating:close': [];
  'floating:configure': [settings: FloatingChatSettings];
  'window:get': [];
  'window:set-close-to-tray': [enabled: boolean];
  'session:snapshot': [];
  'session:start': [manualContext: string, mode?: InferenceMode];
  'session:stop': [];
  'session:retry': [];
  'native:status': [];
  'preferences:get': [];
  'preferences:set': [preferences: SessionPreferences];
  'audience:get': [];
  'audience:regenerate': [mode: InferenceMode];
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
  'audio:configuration:get': [];
  'audio:configuration:set': [inputs: AudioInputConfiguration[]];
  'audio:status': [];
  'audio:capabilities': [];
  'audio:start': [id: string, sourceId: string, label: string, captureId: string];
  'audio:retry': [id: string];
  'audio:label': [id: string, label: string];
  'audio:disconnected': [captureId: string];
  'audio:remove': [id: string];
  'audio:stop': [captureId: string];
  'audio:segment': [segment: AudioSegment, captureId: string];
}

export interface DesktopAPI {
  getChatSnapshot(): Promise<ChatSnapshot>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  publishSample(): Promise<void>;
  getOverlayUrl(): Promise<string>;
  getFloatingChat(): Promise<FloatingChatSnapshot>;
  openFloatingChat(): Promise<FloatingChatSnapshot>;
  closeFloatingChat(): Promise<FloatingChatSnapshot>;
  configureFloatingChat(settings: FloatingChatSettings): Promise<FloatingChatSnapshot>;
  onFloatingChatChange(listener: (state: FloatingChatSnapshot) => void): () => void;
  getWindowStatus(): Promise<WindowStatus>;
  setCloseToTray(enabled: boolean): Promise<WindowStatus>;
  getSessionSnapshot(): Promise<SessionSnapshot>;
  onSessionChange(listener: (status: SessionSnapshot) => void): () => void;
  startSession(manualContext: string, mode?: InferenceMode): Promise<SessionSnapshot>;
  stopSession(): Promise<SessionSnapshot>;
  retrySession(): Promise<SessionSnapshot>;
  getNativeStatus(): Promise<NativeServiceStatus>;
  onNativeChange(listener: (status: NativeServiceStatus) => void): () => void;
  getPreferences(): Promise<SessionPreferences>;
  setPreferences(preferences: SessionPreferences): Promise<SessionPreferences>;
  getAudience(): Promise<AudienceSnapshot>;
  regenerateAudience(mode: InferenceMode): Promise<AudienceSnapshot>;
  onAudienceChange(listener: (snapshot: AudienceSnapshot) => void): () => void;
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
  getAudioConfiguration(): Promise<AudioInputConfiguration[]>;
  setAudioConfiguration(inputs: AudioInputConfiguration[]): Promise<AudioInputConfiguration[]>;
  getAudioStatus(): Promise<AudioStatus>;
  getAudioCapabilities(): Promise<{ windowsLoopback: boolean }>;
  setAudioLabel(id: string, label: string): Promise<AudioStatus>;
  audioDisconnected(captureId: string): Promise<AudioStatus>;
  removeAudioInput(id: string): Promise<AudioStatus>;
  onAudioChange(listener: (snapshot: AudioStatus) => void): () => void;
  startAudio(id: string, sourceId: string, label: string, captureId: string): Promise<AudioStatus>;
  retryAudio(id: string): Promise<AudioStatus>;
  stopAudio(captureId: string): Promise<AudioStatus>;
  submitAudioSegment(segment: AudioSegment, captureId: string): Promise<void>;
}
