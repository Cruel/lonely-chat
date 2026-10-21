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
import type {
  CompactAttemptSummary,
  CompactReconstruction,
  CompactRecordingStatus,
} from './compact-recording-contract';
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
import type { InferenceProfile, InferenceProfileValues } from './inference-profile-contract';
import type {
  RecordedScenario,
  RecordedScenarioConfig,
  RecordedRun,
} from './recorded-scenario-contract';
import type { SimulationExperimentValues } from './playground-contract';
import type { SpeechTestStart, SpeechTestSnapshot } from './speech-playground-contract';
import type {
  VideoToolsStatus,
  PlaygroundVideoSelection,
  NativeVideoPreferences,
} from './video-tools-contract';
import type { SpeechCaptureStatus } from './speech-capture-contract';
import type {
  TranscriptCacheAvailability,
  TranscriptCacheQuery,
} from './recorded-transcript-cache';
import type { OverlayStatus } from './overlay-contract';
import type { ModelDiscoveryResult, ModelRole } from './model-contract';
import type { ModelInstallRequest, ModelManagerSnapshot } from './model-install-contract';

/** IPC return contract: renderer methods and main handlers share the same mapped channels. */
import type {
  RemoteCatalog,
  RemoteConnection,
  RemoteModelConfiguration,
} from './remote-inference-contract';

export interface DesktopInvocations {
  'chatgpt:status': import('./chatgpt-contract').ChatGPTStatus;
  'chatgpt:persistence:set': import('./chatgpt-contract').ChatGPTStatus;
  'chatgpt:signin': import('./chatgpt-contract').ChatGPTStatus;
  'chatgpt:authorization:get': string | null;
  'chatgpt:authorization:open': void;
  'chatgpt:authorization:copy': void;
  'chatgpt:select': import('./chatgpt-contract').ChatGPTStatus;
  'chatgpt:signout': { status: import('./chatgpt-contract').ChatGPTStatus; revoked: boolean };
  'chatgpt:models': import('./chatgpt-contract').ChatGPTModel[];
  'remote:list': RemoteCatalog;
  'remote:usage': readonly import('./remote-inference-contract').RemoteUsageReport[];
  'remote:connection:save': RemoteConnection;
  'remote:connection:delete': void;
  'remote:model:save': RemoteModelConfiguration;
  'remote:model:delete': void;
  'remote:credential:set': 'session' | 'protected' | 'file';
  'remote:models:list': string[];
  'remote:model:inspect': import('./remote-inference-contract').RemoteCapabilityEvidence;
  'remote:model:probe': {
    compatible: true;
    protocol: RemoteConnection['protocol'];
    usage: import('./playground-contract').FreeformUsage;
  };
  'remote:playground:unified': import('./playground-contract').SimulationExperimentResult;
  'diagnostics:get': DiagnosticStatus;
  'diagnostics:configure': DiagnosticStatus;
  'diagnostics:export': boolean;
  'diagnostics:worker-lines': readonly PrivateWorkerLine[];
  'compact:get': CompactRecordingStatus;
  'compact:configure': CompactRecordingStatus;
  'compact:limits': CompactRecordingStatus;
  'compact:save-case': SavedCaseSummary;
  'compact:list': CompactAttemptSummary[];
  'compact:reconstruct': CompactReconstruction | null;
  'logs:get': LogSnapshot;
  'logs:configure': LogRetention;
  'logs:export': boolean;
  'renderer:report-failure': void;
  'playground:status': PlaygroundStatus;
  'video-tools:status': VideoToolsStatus;
  'video-tools:choose-directory': VideoToolsStatus;
  'video-tools:reset': VideoToolsStatus;
  'video-tools:preferences': VideoToolsStatus;
  'playground:video:choose': PlaygroundVideoSelection | null;
  'profiles:list': InferenceProfile[];
  'profiles:revisions': InferenceProfile[];
  'profiles:save': InferenceProfile;
  'profiles:delete': void;
  'presets:list': PromptPreset[];
  'presets:revisions': PromptPreset[];
  'presets:save': PromptPreset;
  'presets:delete': void;
  'playground:run': FreeformResult;
  'playground:simulation:preview': { constructedRequest: unknown; submittedRequest: unknown };
  'profiles:preview-stages': unknown;
  'playground:simulation:run': SimulationExperimentResult;
  'playground:profile:preview': import('./profile-playground-contract').ProfileExperimentPreview;
  'playground:profile:run': import('./profile-playground-contract').ProfileExperimentResult;
  'speech-test:status': SpeechTestSnapshot;
  'speech-test:start': SpeechTestSnapshot;
  'speech-test:pcm': SpeechTestSnapshot;
  'speech-test:finish': SpeechTestSnapshot;
  'speech-test:stop': SpeechTestSnapshot;
  'speech-test:rerun-captured': SpeechTestSnapshot;
  'speech-capture:get': SpeechCaptureStatus;
  'speech-capture:configure': SpeechCaptureStatus;
  'speech-capture:delete': SpeechCaptureStatus;
  'speech-capture:clear': SpeechCaptureStatus;
  'speech-capture:export': boolean;
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
  'scenario:list': RecordedScenario[];
  'scenario:save': RecordedScenario;
  'scenario:delete': void;
  'scenario:runs': RecordedRun[];
  'scenario:export': boolean;
  'scenario:import': { scenario: RecordedScenario; missing: string[] } | null;
  'run:export': boolean;
  'run:import': RecordedRun | null;
  'recorded:media:open': string;
  'recorded:media:choose': string | null;
  'recorded:media:fingerprint': string;
  'session:snapshot': SessionSnapshot;
  'session:start': SessionSnapshot;
  'session:stop': SessionSnapshot;
  'session:pause': SessionSnapshot;
  'session:resume:prepare': void;
  'session:resume:cancel': void;
  'session:resume': SessionSnapshot;
  'session:recorded:eof': SessionSnapshot;
  'session:retry': SessionSnapshot;
  'session:profile:update': SessionSnapshot;
  'native:status': NativeServiceStatus;
  'local-models:unload': void;
  'preferences:get': SessionPreferences;
  'preferences:set': SessionPreferences;
  'audience:get': AudienceSnapshot;
  'audience:regenerate': AudienceSnapshot;
  'models:discover': ModelDiscoveryResult;
  'models:snapshot': ModelManagerSnapshot;
  'models:install': ModelManagerSnapshot;
  'models:projector:set': ModelManagerSnapshot;
  'models:projector:install': ModelManagerSnapshot;
  'models:cancel': void;
  'models:activate': ModelManagerSnapshot;
  'models:remove': ModelManagerSnapshot;
  'models:choose-directory': ModelManagerSnapshot;
  'video:list-displays': VideoSource[];
  'video:clock': number;
  'session:media-error': SessionSnapshot;
  'session:media-issue': SessionSnapshot;
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
  'chatgpt:status': [];
  'chatgpt:persistence:set': [persist: boolean];
  'chatgpt:signin': [accountId?: string];
  'chatgpt:authorization:get': [];
  'chatgpt:authorization:open': [];
  'chatgpt:authorization:copy': [];
  'chatgpt:select': [accountId: string];
  'chatgpt:signout': [accountId: string];
  'chatgpt:models': [accountId: string];
  'remote:list': [];
  'remote:usage': [];
  'remote:connection:save': [connection: RemoteConnection];
  'remote:connection:delete': [id: string];
  'remote:model:save': [configuration: RemoteModelConfiguration];
  'remote:model:delete': [id: string];
  'remote:credential:set': [id: string, secret: string];
  'remote:models:list': [connectionId: string];
  'remote:model:probe': [modelId: string];
  'remote:model:inspect': [modelId: string];
  'remote:playground:unified': [
    request: import('./playground-contract').SimulationExperimentRequest,
    modelConfigurationId: string,
  ];
  'diagnostics:get': [];
  'diagnostics:configure': [enabled: boolean];
  'diagnostics:export': [];
  'diagnostics:worker-lines': [];
  'compact:get': [];
  'compact:configure': [
    enabled: boolean,
    mode?: import('./compact-recording-contract').InferenceRecordingMode,
  ];
  'compact:limits': [limits: import('./compact-recording-contract').RecordingLimits];
  'compact:save-case': [id: string, recordingId: string];
  'compact:list': [];
  'compact:reconstruct': [id: string, recordingId: string];
  'logs:get': [];
  'logs:configure': [retention: LogRetention];
  'logs:export': [ids: readonly string[]];
  'renderer:report-failure': [failure: RendererFailure];
  'playground:status': [];
  'video-tools:status': [];
  'video-tools:choose-directory': [];
  'video-tools:reset': [];
  'video-tools:preferences': [preferences: NativeVideoPreferences];
  'playground:video:choose': [preferences?: NativeVideoPreferences];
  'profiles:list': [];
  'profiles:revisions': [id: string];
  'profiles:save': [input: { id?: string; name: string; values: InferenceProfileValues }];
  'profiles:delete': [id: string];
  'presets:list': [];
  'presets:revisions': [id: string];
  'presets:save': [input: { id?: string; name: string; values: SimulationExperimentValues }];
  'presets:delete': [id: string];
  'playground:run': [request: FreeformRequest];
  'playground:simulation:preview': [request: SimulationExperimentRequest];
  'profiles:preview-stages': [input: import('../main/fake-inference').InferenceInput, stages: InferenceProfileValues['stageDefaults'], events: import('../shared/session-contract').InferredEvent[], observations: import('../shared/session-contract').CapturedObservation[]];
  'playground:simulation:run': [request: SimulationExperimentRequest];
  'playground:profile:preview': [request: import('./profile-playground-contract').ProfileExperimentRequest];
  'playground:profile:run': [request: import('./profile-playground-contract').ProfileExperimentRequest];
  'speech-test:status': [];
  'speech-test:start': [config: SpeechTestStart];
  'speech-test:pcm': [samples: Float32Array, backpressure?: boolean];
  'speech-test:finish': [];
  'speech-test:stop': [];
  'speech-test:rerun-captured': [id: string];
  'speech-capture:get': [];
  'speech-capture:configure': [enabled: boolean];
  'speech-capture:delete': [id: string];
  'speech-capture:clear': [];
  'speech-capture:export': [id: string];
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
  'scenario:list': [];
  'scenario:save': [name: string, config: RecordedScenarioConfig, id?: string];
  'scenario:delete': [id: string];
  'scenario:runs': [];
  'scenario:export': [id: string, includeMedia: boolean];
  'scenario:import': [];
  'run:export': [id: string];
  'run:import': [];
  'recorded:media:open': [path: string];
  'recorded:media:choose': [kind: 'video' | 'audio'];
  'recorded:media:fingerprint': [path: string];
  'session:snapshot': [];
  'session:start': [manualContext: string, mode?: InferenceMode, options?: SimulationInputOptions];
  'session:stop': [];
  'session:pause': [];
  'session:resume:prepare': [];
  'session:resume:cancel': [];
  'session:resume': [];
  'session:recorded:eof': [];
  'session:retry': [];
  'session:profile:update': [id: string, revision: number];
  'native:status': [];
  'local-models:unload': [];
  'preferences:get': [];
  'preferences:set': [preferences: SessionPreferences];
  'audience:get': [];
  'audience:regenerate': [mode: InferenceMode];
  'models:discover': [source: string];
  'models:snapshot': [];
  'models:install': [selection: ModelInstallRequest];
  'models:projector:set': [
    id: string,
    source: import('./model-install-contract').ProjectorAssignment,
  ];
  'models:projector:install': [id: string, source: string, candidateId: string];
  'models:cancel': [];
  'models:activate': [role: ModelRole, id: string | null];
  'models:remove': [id: string];
  'models:choose-directory': [];
  'video:list-displays': [];
  'video:clock': [];
  'session:media-error': [message: string];
  'session:media-issue': [issue: import('./recorded-media-health').RecordedMediaIssue];
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
  getChatGPTStatus?(): Promise<import('./chatgpt-contract').ChatGPTStatus>;
  setCredentialPersistence?(persist: boolean): Promise<import('./chatgpt-contract').ChatGPTStatus>;
  signInChatGPT?(accountId?: string): Promise<import('./chatgpt-contract').ChatGPTStatus>;
  getChatGPTAuthorizationUrl?(): Promise<string | null>;
  openChatGPTAuthorizationUrl?(): Promise<void>;
  copyChatGPTAuthorizationUrl?(): Promise<void>;
  onChatGPTAuthorizationChange?(listener: (url: string | null) => void): () => void;
  selectChatGPTAccount?(accountId: string): Promise<import('./chatgpt-contract').ChatGPTStatus>;
  signOutChatGPT?(accountId: string): Promise<DesktopInvocations['chatgpt:signout']>;
  listChatGPTModels?(accountId: string): Promise<import('./chatgpt-contract').ChatGPTModel[]>;
  listRemoteConfigurations?(): Promise<RemoteCatalog>;
  getRemoteUsage?(): Promise<DesktopInvocations['remote:usage']>;
  saveRemoteConnection?(connection: RemoteConnection): Promise<RemoteConnection>;
  deleteRemoteConnection?(id: string): Promise<void>;
  saveRemoteModel?(configuration: RemoteModelConfiguration): Promise<RemoteModelConfiguration>;
  deleteRemoteModel?(id: string): Promise<void>;
  setRemoteCredential?(id: string, secret: string): Promise<'session' | 'protected' | 'file'>;
  listRemoteModels?(connectionId: string): Promise<string[]>;
  probeRemoteModel?(modelId: string): Promise<DesktopInvocations['remote:model:probe']>;
  inspectRemoteModel?(modelId: string): Promise<DesktopInvocations['remote:model:inspect']>;
  runRemoteUnifiedPlayground?(
    request: import('./playground-contract').SimulationExperimentRequest,
    modelConfigurationId: string,
  ): Promise<import('./playground-contract').SimulationExperimentResult>;
  getDiagnosticCapture(): Promise<DiagnosticStatus>;
  configureDiagnosticCapture(enabled: boolean): Promise<DiagnosticStatus>;
  exportDiagnosticCapture(): Promise<boolean>;
  getPrivateWorkerLines(): Promise<readonly PrivateWorkerLine[]>;
  getCompactRecording(): Promise<CompactRecordingStatus>;
  configureCompactRecording(
    enabled: boolean,
    mode?: import('./compact-recording-contract').InferenceRecordingMode,
  ): Promise<CompactRecordingStatus>;
  setCompactRecordingLimits(
    limits: import('./compact-recording-contract').RecordingLimits,
  ): Promise<CompactRecordingStatus>;
  saveRecordedExactCase(id: string, recordingId: string): Promise<SavedCaseSummary>;
  listCompactAttempts(): Promise<CompactAttemptSummary[]>;
  reconstructCompactAttempt(id: string, recordingId: string): Promise<CompactReconstruction | null>;
  getPlaygroundStatus(): Promise<PlaygroundStatus>;
  getVideoTools(): Promise<VideoToolsStatus>;
  chooseVideoToolsDirectory(): Promise<VideoToolsStatus>;
  resetVideoToolsDirectory(): Promise<VideoToolsStatus>;
  configureNativeVideoPreferences(preferences: NativeVideoPreferences): Promise<VideoToolsStatus>;
  onVideoToolsChange(listener: (status: VideoToolsStatus) => void): () => void;
  choosePlaygroundVideo(
    preferences?: NativeVideoPreferences,
  ): Promise<PlaygroundVideoSelection | null>;
  listInferenceProfiles(): Promise<InferenceProfile[]>;
  listInferenceProfileRevisions(id: string): Promise<InferenceProfile[]>;
  saveInferenceProfile(input: {
    id?: string;
    name: string;
    values: InferenceProfileValues;
  }): Promise<InferenceProfile>;
  deleteInferenceProfile(id: string): Promise<void>;
  listPromptPresets(): Promise<PromptPreset[]>;
  listPromptPresetRevisions(id: string): Promise<PromptPreset[]>;
  savePromptPreset(input: {
    id?: string;
    name: string;
    values: SimulationExperimentValues;
  }): Promise<PromptPreset>;
  deletePromptPreset(id: string): Promise<void>;
  runFreeform(request: FreeformRequest): Promise<FreeformResult>;
  previewStages(input: import('../main/fake-inference').InferenceInput, stages: InferenceProfileValues['stageDefaults'], events: import('../shared/session-contract').InferredEvent[], observations: import('../shared/session-contract').CapturedObservation[]): Promise<unknown>;
  previewSimulation(
    request: SimulationExperimentRequest,
  ): Promise<{ constructedRequest: unknown; submittedRequest: unknown }>;
  runSimulationExperiment(
    request: SimulationExperimentRequest,
  ): Promise<SimulationExperimentResult>;
  previewProfileExperiment?(request: import('./profile-playground-contract').ProfileExperimentRequest): Promise<import('./profile-playground-contract').ProfileExperimentPreview>;
  runProfileExperiment?(request: import('./profile-playground-contract').ProfileExperimentRequest): Promise<import('./profile-playground-contract').ProfileExperimentResult>;
  getSpeechTestStatus(): Promise<SpeechTestSnapshot>;
  startSpeechTest(config: SpeechTestStart): Promise<SpeechTestSnapshot>;
  submitSpeechTestPcm(samples: Float32Array, backpressure?: boolean): Promise<SpeechTestSnapshot>;
  finishSpeechTest(): Promise<SpeechTestSnapshot>;
  stopSpeechTest(): Promise<SpeechTestSnapshot>;
  rerunCapturedSpeech(id: string): Promise<SpeechTestSnapshot>;
  getSpeechCapture(): Promise<SpeechCaptureStatus>;
  configureSpeechCapture(enabled: boolean): Promise<SpeechCaptureStatus>;
  deleteCapturedSpeech(id: string): Promise<SpeechCaptureStatus>;
  clearCapturedSpeech(): Promise<SpeechCaptureStatus>;
  exportCapturedSpeech(id: string): Promise<boolean>;
  onSpeechCaptureChange(listener: (status: SpeechCaptureStatus) => void): () => void;
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
  listRecordedScenarios?(): Promise<RecordedScenario[]>;
  saveRecordedScenario?(
    name: string,
    config: RecordedScenarioConfig,
    id?: string,
  ): Promise<RecordedScenario>;
  deleteRecordedScenario?(id: string): Promise<void>;
  listRecordedRuns?(): Promise<RecordedRun[]>;
  exportRecordedScenario?(id: string, includeMedia: boolean): Promise<boolean>;
  importRecordedScenario?(): Promise<{ scenario: RecordedScenario; missing: string[] } | null>;
  exportRecordedRun?(id: string): Promise<boolean>;
  importRecordedRun?(): Promise<RecordedRun | null>;
  /** File paths are returned only for File objects explicitly selected in the desktop window. */
  pathForRecordedFile?(file: File): string | null;
  openRecordedMedia?(path: string): Promise<string>;
  chooseRecordedMedia?(kind: 'video' | 'audio'): Promise<string | null>;
  fingerprintRecordedMedia?(path: string): Promise<string>;
  onInferenceTraces(listener: (snapshot: TraceList) => void): () => void;
  getSessionSnapshot(): Promise<SessionSnapshot>;
  onSessionChange(listener: (status: SessionSnapshot) => void): () => void;
  startSession(
    manualContext: string,
    mode?: InferenceMode,
    options?: SimulationInputOptions,
  ): Promise<SessionSnapshot>;
  stopSession(): Promise<SessionSnapshot>;
  pauseSession(): Promise<SessionSnapshot>;
  prepareRecordedResume(): Promise<void>;
  cancelRecordedResume(): Promise<void>;
  resumeSession(): Promise<SessionSnapshot>;
  finishRecordedSession(): Promise<SessionSnapshot>;
  onMediaStop(listener: () => void): () => void;
  retrySession(): Promise<SessionSnapshot>;
  queueSessionProfileUpdate?(id: string, revision: number): Promise<SessionSnapshot>;
  getNativeStatus(): Promise<NativeServiceStatus>;
  unloadLocalModels(): Promise<void>;
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
  setModelProjector(
    id: string,
    source: import('./model-install-contract').ProjectorAssignment,
  ): Promise<ModelManagerSnapshot>;
  installModelProjector(
    id: string,
    source: string,
    candidateId: string,
  ): Promise<ModelManagerSnapshot>;
  cancelModelDownload(): Promise<void>;
  activateModel(role: ModelRole, id: string | null): Promise<ModelManagerSnapshot>;
  removeModel(id: string): Promise<ModelManagerSnapshot>;
  chooseModelDirectory(): Promise<ModelManagerSnapshot>;
  getVideoClock(): Promise<number>;
  reportRecordedVideoError(message: string): Promise<SessionSnapshot>;
  reportRecordedMediaIssue?(
    issue: import('./recorded-media-health').RecordedMediaIssue,
  ): Promise<SessionSnapshot>;
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
