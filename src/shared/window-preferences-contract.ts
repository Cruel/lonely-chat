import {
  DEFAULT_FLOATING_CHAT_SETTINGS,
  validateFloatingChatSettings,
  type FloatingChatSettings,
} from './floating-chat-contract';

export interface WindowPreferences {
  closeToTray: boolean;
  floating: FloatingChatSettings;
}

export const DEFAULT_WINDOW_PREFERENCES: WindowPreferences = {
  closeToTray: true,
  floating: { ...DEFAULT_FLOATING_CHAT_SETTINGS },
};

export function validateWindowPreferences(value: unknown): WindowPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid window preferences.');
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    !Object.hasOwn(fields, 'closeToTray') ||
    !Object.hasOwn(fields, 'floating') ||
    typeof fields.closeToTray !== 'boolean'
  ) {
    throw new Error('Invalid window preferences.');
  }
  return {
    closeToTray: fields.closeToTray,
    floating: validateFloatingChatSettings(fields.floating as FloatingChatSettings),
  };
}
