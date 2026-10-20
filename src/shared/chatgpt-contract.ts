/** Public ChatGPT account metadata only; OAuth tokens and identity subjects stay in main. */
export interface ChatGPTAccount {
  readonly id: string;
  readonly label: string;
  readonly email: string | null;
}
export interface ChatGPTStatus {
  /** Whether the current OS backend can encrypt refresh tokens durably. */
  readonly secureStorageAvailable: boolean;
  readonly activeAccountId: string | null;
  readonly accounts: readonly (ChatGPTAccount & {
    readonly authorized: boolean;
    readonly storage: 'session' | 'protected' | 'missing';
  })[];
}
export interface ChatGPTModel {
  readonly id: string;
  readonly name: string;
}
