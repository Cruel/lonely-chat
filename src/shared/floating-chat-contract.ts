/** A second Electron window is only a presentation client of the public overlay. */
export interface FloatingChatSettings {
  width: number;
  height: number;
  transparent: boolean;
  decorated: boolean;
  alwaysOnTop: boolean;
}

export interface FloatingChatSnapshot {
  open: boolean;
  settings: FloatingChatSettings;
  warning: string | null;
}

export const DEFAULT_FLOATING_CHAT_SETTINGS: FloatingChatSettings = {
  width: 420,
  height: 600,
  transparent: false,
  decorated: true,
  alwaysOnTop: false,
};

export const FLOATING_CHAT_BOUNDS = {
  minWidth: 240,
  maxWidth: 1920,
  minHeight: 240,
  maxHeight: 1440,
} as const;

export function validateFloatingChatSettings(value: FloatingChatSettings): FloatingChatSettings {
  if (
    !value ||
    !Number.isInteger(value.width) ||
    value.width < FLOATING_CHAT_BOUNDS.minWidth ||
    value.width > FLOATING_CHAT_BOUNDS.maxWidth ||
    !Number.isInteger(value.height) ||
    value.height < FLOATING_CHAT_BOUNDS.minHeight ||
    value.height > FLOATING_CHAT_BOUNDS.maxHeight ||
    typeof value.transparent !== 'boolean' ||
    typeof value.decorated !== 'boolean' ||
    typeof value.alwaysOnTop !== 'boolean'
  ) {
    throw new Error('Invalid floating chat window settings.');
  }
  return {
    width: value.width,
    height: value.height,
    transparent: value.transparent,
    decorated: value.decorated,
    alwaysOnTop: value.alwaysOnTop,
  };
}
