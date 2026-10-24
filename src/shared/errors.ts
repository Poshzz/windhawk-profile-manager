export const ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  ENVIRONMENT: 'ENVIRONMENT',
  ELEVATION_CANCELED: 'ELEVATION_CANCELED',
  APPLY_FAILED: 'APPLY_FAILED',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
  STALE_PLAN: 'STALE_PLAN',
  STALE_PROFILE: 'STALE_PROFILE',
  COMPATIBILITY: 'COMPATIBILITY',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface SerializedError {
  readonly code: ErrorCode;
  readonly name: string;
  readonly message: string;
  readonly details: readonly ErrorDetail[];
}

export interface WpmErrorOptions {
  readonly details?: readonly ErrorDetail[];
  readonly cause?: unknown;
}

export class WpmError extends Error {
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[];

  constructor(code: ErrorCode, message: string, options: WpmErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? [];
  }
}

export class ValidationError extends WpmError {
  constructor(
    message: string,
    details: readonly ErrorDetail[] = [],
    options: WpmErrorOptions = {},
  ) {
    super(ERROR_CODES.VALIDATION, message, { ...options, details });
  }
}

export class NotFoundError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.NOT_FOUND, message, options);
  }
}

export class EnvironmentError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.ENVIRONMENT, message, options);
  }
}

export class ElevationCanceledError extends WpmError {
  constructor(
    message = 'Elevation was canceled; no changes were made.',
    options: WpmErrorOptions = {},
  ) {
    super(ERROR_CODES.ELEVATION_CANCELED, message, options);
  }
}

export class ApplyError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.APPLY_FAILED, message, options);
  }
}

export class RollbackError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.ROLLBACK_FAILED, message, options);
  }
}

export class StalePlanError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.STALE_PLAN, message, options);
  }
}

export class StaleProfileError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.STALE_PROFILE, message, options);
  }
}

export class JournalLockError extends WpmError {
  constructor(
    message = 'Another apply or restore is already running.',
    options: WpmErrorOptions = {},
  ) {
    super(ERROR_CODES.APPLY_FAILED, message, options);
  }
}

export class CompatibilityError extends WpmError {
  constructor(message: string, options: WpmErrorOptions = {}) {
    super(ERROR_CODES.COMPATIBILITY, message, options);
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof WpmError) {
    return {
      code: error.code,
      name: error.name,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: ERROR_CODES.INTERNAL,
      name: error.name,
      message: error.message,
      details: [],
    };
  }

  return {
    code: ERROR_CODES.INTERNAL,
    name: 'Error',
    message: String(error),
    details: [],
  };
}

export function toErrorDetail(path: readonly (string | number)[], message: string): ErrorDetail {
  return { path, message };
}
