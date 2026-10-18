import type { SimulationExperimentValues } from './playground-contract';

/** User-authored structured prompt inputs; revision content is immutable once saved. */
export interface PromptPreset {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly values: SimulationExperimentValues;
}
