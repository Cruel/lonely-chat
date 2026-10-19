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

import type {
  InferenceMode,
  SessionPreferences,
  SessionSnapshot,
  SimulationInputOptions,
} from './session-contract';
import type { FloatingChatSettings, FloatingChatSnapshot } from './floating-chat-contract';
import type { WindowStatus } from './window-status-contract';
import type { AudienceSnapshot } from './audience-contract';
import type { NativeServiceStatus } from './native-service-contract';
import type { VideoFrame, VideoSource } from './video-contract';
import type {
  AudioInputConfiguration,
  AudioSegment,
  AudioStatus,
  RecordedAudioStart,
} from './audio-contract';
import type { DiagnosticStatus, PrivateWorkerLine } from './diagnostic-contract';
import type { LogEntry, LogRetention, LogSnapshot } from './log-contract';
import type { TraceAttempt, TraceFilter, TraceList } from './inference-trace-contract';
import type {
  SavedCaseDetail,
  SavedCaseFork,
  SavedCaseForkResult,
  SavedCaseSummary,
} from './saved-case-contract';
import type { RendererFailure } from './renderer-log-contract';
import type {
  FreeformRequest,
  FreeformResult,
  PlaygroundStatus,
  SimulationExperimentRequest,
  SimulationExperimentResult,
} from './playground-contract';
import type { PromptPreset } from './prompt-preset-contract';
import type { SimulationExperimentValues } from './playground-contract';
import type { SpeechTestStart, SpeechTestSnapshot } from './speech-playground-contract';
import type {
  TranscriptCacheAvailability,
  TranscriptCacheQuery,
} from './recorded-transcript-cache';
import type { OverlayStatus } from './overlay-contract';
import type { ModelDiscoveryResult, ModelRole } from './model-contract';
import type { ModelInstallRequest, ModelManagerSnapshot } from './model-install-contract';

/** IPC return contract: renderer methods and main handlers share the same mapped channels. */
export interface DesktopInvocations {
  'diagnostics:get': DiagnosticStatus;
  'diagnostics:configure': DiagnosticStatus;
  'diagnostics:export': boolean;
  'diagnostics:worker-lines': readonly PrivateWorkerLine[];
  'logs:get': LogSnapshot;
  'logs:configure': LogRetention;
  'logs:export': boolean;
  'renderer:report-failure': void;
  'playground:status': PlaygroundStatus;
  'presets:list': PromptPreset[];
  'presets:revisions': PromptPreset[];
  'presets:save': PromptPreset;
  'presets:delete': void;
  'playground:run': FreeformResult;
  'playground:simulation:preview': { constructedRequest: unknown; submittedRequest: unknown };
  'playground:simulation:run': SimulationExperimentResult;
  'speech-test:status': SpeechTestSnapshot;
  'speech-test:start': SpeechTestSnapshot;
  'speech-test:pcm': SpeechTestSnapshot;
  'speech-test:finish': SpeechTestSnapshot;
  'speech-test:stop': SpeechTestSnapshot;
  'chat:snapshot': ChatSnapshot;
  'chat:sample': void;
  'overlay:url': string | null;
  'overlay:status': OverlayStatus;
  'overlay:configure': OverlayStatus;
  'floating:get': FloatingChatSnapshot;
  'floating:open': FloatingChatSnapshot;
  'floating:close': FloatingChatSnapshot;
  'floating:configure': FloatingChatSnapshot;
  'window:get': WindowStatus;
  'window:set-close-to-tray': WindowStatus;
  'trace:list': TraceList;
  'trace:get': TraceAttempt | null;
  'trace:search': readonly string[];
  'case:list': SavedCaseSummary[];
  'case:get': SavedCaseDetail;
  'case:save': SavedCaseSummary;
  'case:run': SavedCaseForkResult;
  'case:export': boolean;
  'case:import': SavedCaseSummary | null;
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
  'video:clock': number;
  'session:media-error': SessionSnapshot;
  'video:select': number;
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
  'audio:cache:check': TranscriptCacheAvailability;
  'audio:recorded:start': AudioStatus;
  'audio:recorded:arm': void;
  'audio:recorded:resync': void;
  'audio:recorded:pcm': void;
  'audio:recorded:finish': void;
}

/** Method arguments are also a shared contract, not renderer-defined strings. */
export interface DesktopArguments {
  'diagnostics:get': [];
  'diagnostics:configure': [enabled: boolean];
  'diagnostics:export': [];
  'diagnostics:worker-lines': [];
  'logs:get': [];
  'logs:configure': [retention: LogRetention];
  'logs:export': [ids: readonly string[]];
  'renderer:report-failure': [failure: RendererFailure];
  'playground:status': [];
  'presets:list': [];
  'presets:revisions': [id: string];
  'presets:save': [input: { id?: string; name: string; values: SimulationExperimentValues }];
  'presets:delete': [id: string];
  'playground:run': [request: FreeformRequest];
  'playground:simulation:preview': [request: SimulationExperimentRequest];
  'playground:simulation:run': [request: SimulationExperimentRequest];
  'speech-test:status': [];
  'speech-test:start': [config: SpeechTestStart];
  'speech-test:pcm': [samples: Float32Array, backpressure?: boolean];
  'speech-test:finish': [];
  'speech-test:stop': [];
  'chat:snapshot': [];
  'chat:sample': [];
  'overlay:url': [];
  'overlay:status': [];
  'overlay:configure': [port: number];
  'floating:get': [];
  'floating:open': [];
  'floating:close': [];
  'floating:configure': [settings: FloatingChatSettings];
  'window:get': [];
  'window:set-close-to-tray': [enabled: boolean];
  'trace:list': [];
  'trace:get': [id: string];
  'trace:search': [filter: TraceFilter];
  'case:list': [];
  'case:get': [id: string];
  'case:save': [attemptId: string];
  'case:run': [fork: SavedCaseFork];
  'case:export': [id: string];
  'case:import': [];
  'session:snapshot': [];
  'session:start': [manualContext: string, mode?: InferenceMode, options?: SimulationInputOptions];
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
  'video:clock': [];
  'session:media-error': [message: string];
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
  'audio:cache:check': [query: TranscriptCacheQuery];
  'audio:recorded:start': [source: RecordedAudioStart];
  'audio:recorded:arm': [captureId: string, originMs: number, mediaStartMs: number];
  'audio:recorded:resync': [captureId: string, originMs: number, mediaStartMs: number];
  'audio:recorded:pcm': [samples: Float32Array, captureId: string];
  'audio:recorded:finish': [captureId: string];
}

export interface DesktopAPI {
  getDiagnosticCapture(): Promise<DiagnosticStatus>;
  configureDiagnosticCapture(enabled: boolean): Promise<DiagnosticStatus>;
  exportDiagnosticCapture(): Promise<boolean>;
  getPrivateWorkerLines(): Promise<readonly PrivateWorkerLine[]>;
  getPlaygroundStatus(): Promise<PlaygroundStatus>;
  listPromptPresets(): Promise<PromptPreset[]>;
  listPromptPresetRevisions(id: string): Promise<PromptPreset[]>;
  savePromptPreset(input: {
    id?: string;
    name: string;
    values: SimulationExperimentValues;
  }): Promise<PromptPreset>;
  deletePromptPreset(id: string): Promise<void>;
  runFreeform(request: FreeformRequest): Promise<FreeformResult>;
  previewSimulation(
    request: SimulationExperimentRequest,
  ): Promise<{ constructedRequest: unknown; submittedRequest: unknown }>;
  runSimulationExperiment(
    request: SimulationExperimentRequest,
  ): Promise<SimulationExperimentResult>;
  getSpeechTestStatus(): Promise<SpeechTestSnapshot>;
  startSpeechTest(config: SpeechTestStart): Promise<SpeechTestSnapshot>;
  submitSpeechTestPcm(samples: Float32Array, backpressure?: boolean): Promise<SpeechTestSnapshot>;
  finishSpeechTest(): Promise<SpeechTestSnapshot>;
  stopSpeechTest(): Promise<SpeechTestSnapshot>;
  onSpeechTestChange(listener: (snapshot: SpeechTestSnapshot) => void): () => void;
  onPlaygroundStatus(listener: (status: PlaygroundStatus) => void): () => void;
  getOperationalLogs(): Promise<LogSnapshot>;
  configureOperationalLogs(retention: LogRetention): Promise<LogRetention>;
  exportOperationalLogs(ids: readonly string[]): Promise<boolean>;
  reportRendererFailure(failure: RendererFailure): Promise<void>;
  onOperationalLog(listener: (entry: LogEntry) => void): () => void;
  getChatSnapshot(): Promise<ChatSnapshot>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  publishSample(): Promise<void>;
  getOverlayUrl(): Promise<string | null>;
  getOverlayStatus(): Promise<OverlayStatus>;
  configureOverlayPort(port: number): Promise<OverlayStatus>;
  onOverlayChange(listener: (status: OverlayStatus) => void): () => void;
  getFloatingChat(): Promise<FloatingChatSnapshot>;
  openFloatingChat(): Promise<FloatingChatSnapshot>;
  closeFloatingChat(): Promise<FloatingChatSnapshot>;
  configureFloatingChat(settings: FloatingChatSettings): Promise<FloatingChatSnapshot>;
  onFloatingChatChange(listener: (state: FloatingChatSnapshot) => void): () => void;
  getWindowStatus(): Promise<WindowStatus>;
  setCloseToTray(enabled: boolean): Promise<WindowStatus>;
  listInferenceTraces(): Promise<TraceList>;
  getInferenceTrace(id: string): Promise<TraceAttempt | null>;
  searchInferenceTraces?(filter: TraceFilter): Promise<readonly string[]>;
  listSavedCases?(): Promise<SavedCaseSummary[]>;
  getSavedCase?(id: string): Promise<SavedCaseDetail>;
  saveInferenceCase?(attemptId: string): Promise<SavedCaseSummary>;
  runSavedCase?(fork: SavedCaseFork): Promise<SavedCaseForkResult>;
  exportSavedCase?(id: string): Promise<boolean>;
  importSavedCase?(): Promise<SavedCaseSummary | null>;
  onInferenceTraces(listener: (snapshot: TraceList) => void): () => void;
  getSessionSnapshot(): Promise<SessionSnapshot>;
  onSessionChange(listener: (status: SessionSnapshot) => void): () => void;
  startSession(
    manualContext: string,
    mode?: InferenceMode,
    options?: SimulationInputOptions,
  ): Promise<SessionSnapshot>;
  stopSession(): Promise<SessionSnapshot>;
  onMediaStop(listener: () => void): () => void;
  retrySession(): Promise<SessionSnapshot>;
  getNativeStatus(): Promise<NativeServiceStatus>;
  onNativeChange(listener: (status: NativeServiceStatus) => void): () => void;
  getPreferences(): Promise<SessionPreferences>;
  setPreferences(preferences: SessionPreferences): Promise<SessionPreferences>;
  getAudience(): Promise<AudienceSnapshot>;
  regenerateAudience(mode: InferenceMode, seed?: number): Promise<AudienceSnapshot>;
  onAudienceChange(listener: (snapshot: AudienceSnapshot) => void): () => void;
  discoverModels(source: string): Promise<ModelDiscoveryResult>;
  getModelsSnapshot(): Promise<ModelManagerSnapshot>;
  onModelsChange(listener: (snapshot: ModelManagerSnapshot) => void): () => void;
  installModel(selection: ModelInstallRequest): Promise<ModelManagerSnapshot>;
  cancelModelDownload(): Promise<void>;
  activateModel(role: ModelRole, id: string | null): Promise<ModelManagerSnapshot>;
  removeModel(id: string): Promise<ModelManagerSnapshot>;
  chooseModelDirectory(): Promise<ModelManagerSnapshot>;
  getVideoClock(): Promise<number>;
  reportRecordedVideoError(message: string): Promise<SessionSnapshot>;
  listDisplaySources(): Promise<VideoSource[]>;
  /** Returns main-process observation time for aligning renderer capture timestamps. */
  selectVideoSource(sourceId: string | null): Promise<number>;
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
  checkRecordedAudioCache(query: TranscriptCacheQuery): Promise<TranscriptCacheAvailability>;
  startRecordedAudio(source: RecordedAudioStart): Promise<AudioStatus>;
  armRecordedAudio(captureId: string, originMs: number, mediaStartMs: number): Promise<void>;
  resyncRecordedAudio(captureId: string, originMs: number, mediaStartMs: number): Promise<void>;
  submitRecordedAudioPcm(samples: Float32Array, captureId: string): Promise<void>;
  finishRecordedAudio(captureId: string): Promise<void>;
}
