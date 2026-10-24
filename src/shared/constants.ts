export const APP_ID = 'com.poshzz.windhawk-profile-manager';
export const PRODUCT_NAME = 'Windhawk Profile Manager';
export const TITLEBAR_HEIGHT = 48;
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 600;
export const DEFAULT_WINDOW_WIDTH = 1120;
export const DEFAULT_WINDOW_HEIGHT = 740;

/** Stable elevated-helper exit codes. These are part of the broker contract. */
export const HELPER_EXIT_CODES = {
  success: 0,
  validationFailure: 2,
  applyFailure: 3,
  rollbackFailure: 4,
} as const;

export const HELPER_WATCHDOG_MS = 120_000;
export const MAX_HELPER_PLAN_BYTES = 8 * 1024 * 1024;
