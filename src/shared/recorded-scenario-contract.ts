import type { InferenceMode, SessionPreferences } from './session-contract';
import type { InferenceProfile } from './inference-profile-contract';
import type { RecordedTranscriptMode } from './recorded-transcript-cache';
import type { RecordedSegment } from '../renderer/recorded-preview-timeline';

/** Source media is referenced by absolute desktop path, never copied into Scenario/Run storage. */
export interface RecordedScenarioConfig {
  readonly context: string;
  readonly mode: InferenceMode;
  readonly video: { readonly path: string; readonly offsetMs?: number } | null;
  readonly audio: readonly {
    readonly id: string;
    readonly kind: 'file' | 'video' | 'device';
    /** Local Chromium audioinput device identity; not a file path. */
    readonly deviceId?: string | null;
    readonly path: string | null;
    readonly label: string;
    readonly enabled: boolean;
    readonly offsetMs: number;
    readonly embeddedTrackIndex: number | null;
  }[];
  readonly segment: RecordedSegment;
  readonly transcriptMode: RecordedTranscriptMode;
  readonly publishToOverlay: boolean;
  readonly seed: number | null;
  readonly presetId: string | null;
  readonly presetRevision: number | null;
  readonly profileId?: string | null;
  readonly profileRevision?: number | null;
  readonly profileSnapshot?: InferenceProfile | null;
  readonly modelId: string | null;
  /** The saved snapshot is immutable unless the user explicitly saves a revised Scenario. */
  readonly settingsSnapshot: SessionPreferences;
  readonly settingsPolicy: 'saved' | 'current';
}

export interface RecordedScenario {
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly config: RecordedScenarioConfig;
}

/** Content-bearing inference history is opt-in via the independent Compact recorder. */
export interface RecordedRun {
  readonly id: string;
  readonly scenarioId: string | null;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly sessionRunId: number;
  /** Exact local private recording directories associated with this Run. */
  readonly recordingIds?: readonly string[];
  readonly status: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  readonly cycles: number;
  readonly error: string | null;
  readonly effective: RecordedScenarioConfig;
  readonly effectiveSettings: SessionPreferences;
  readonly effectiveProfile?: InferenceProfile | null;
  readonly effectiveModelId: string | null;
  readonly effectivePreset: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
  } | null;
  /** Snapshot the actual prompt resolved at Start, even if the preset is later deleted. */
  readonly effectivePrompt: {
    readonly context: string;
    readonly chatActivity: SessionPreferences['chatActivity'];
  };
  readonly effectiveSeed: number;
}
