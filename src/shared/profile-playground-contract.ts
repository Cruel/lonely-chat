import type { InferenceRole, ProfileModelReference } from './inference-profile-contract';
import type { SimulationExperimentRequest, FreeformUsage } from './playground-contract';
import type { InferredEvent, CapturedObservation } from './session-contract';

export type ProfileExperimentMode = 'vision' | 'chat' | 'pipeline';

export interface ProfileExperimentRequest {
  readonly profileId: string;
  readonly profileRevision?: number;
  readonly mode: ProfileExperimentMode;
  readonly experiment: SimulationExperimentRequest;
  /** Private, process-owned output of an earlier successful Vision experiment. */
  readonly visionReferenceId?: string;
}

export interface ProfileStageEvidence {
  readonly role: InferenceRole;
  readonly model: ProfileModelReference;
  readonly constructedRequest: unknown;
  readonly submittedRequest: unknown;
  readonly rawResponse: unknown | null;
  readonly normalized: unknown | null;
  readonly parsed: unknown | null;
  readonly accepted: unknown | null;
  readonly usage: FreeformUsage | null;
  readonly error: string | null;
  readonly status: 'running' | 'accepted' | 'failed' | 'cancelled';
}

export interface VisionExperimentReference {
  readonly id: string;
  readonly label: string;
  readonly profileId: string;
  readonly profileRevision: number;
}

export interface ProfileExperimentResult {
  readonly id: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly mode: ProfileExperimentMode;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stages: readonly ProfileStageEvidence[];
  readonly accepted: {
    readonly events: readonly InferredEvent[];
    readonly messages: readonly { author: string; color: string; text: string; offsetMs: number }[];
  } | null;
  readonly observations: readonly CapturedObservation[];
  readonly visionReference: VisionExperimentReference | null;
  readonly sourceVisionReference: string | null;
  readonly error: string | null;
}

export interface ProfileExperimentPreview {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly mode: ProfileExperimentMode;
  readonly stages: readonly {
    readonly role: InferenceRole;
    readonly model: ProfileModelReference;
    readonly request: unknown;
    readonly modelSettings: unknown;
  }[];
  readonly sourceVisionReference: string | null;
}
