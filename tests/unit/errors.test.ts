import { describe, expect, it } from 'vitest';
import {
  ApplyError,
  CompatibilityError,
  ElevationCanceledError,
  EnvironmentError,
  ERROR_CODES,
  NotFoundError,
  RollbackError,
  StalePlanError,
  StaleProfileError,
  ValidationError,
  serializeError,
  toErrorDetail,
} from '@shared/errors';

describe('error taxonomy', () => {
  it.each([
    [ValidationError, ERROR_CODES.VALIDATION],
    [NotFoundError, ERROR_CODES.NOT_FOUND],
    [EnvironmentError, ERROR_CODES.ENVIRONMENT],
    [ElevationCanceledError, ERROR_CODES.ELEVATION_CANCELED],
    [ApplyError, ERROR_CODES.APPLY_FAILED],
    [RollbackError, ERROR_CODES.ROLLBACK_FAILED],
    [StalePlanError, ERROR_CODES.STALE_PLAN],
    [StaleProfileError, ERROR_CODES.STALE_PROFILE],
    [CompatibilityError, ERROR_CODES.COMPATIBILITY],
  ] as const)('uses a stable code for %s', (ErrorType, code) => {
    const error = new ErrorType('failure');

    expect(error.code).toBe(code);
    expect(error.name).toBe(ErrorType.name);
  });

  it('keeps field details on validation errors', () => {
    const detail = toErrorDetail(['requiredMods', 0, 'modId'], 'Invalid mod ID.');
    const error = new ValidationError('Profile is invalid.', [detail]);

    expect(error.details).toEqual([detail]);
    expect(error.message).toBe('Profile is invalid.');
  });

  it('serializes typed and unknown errors for IPC', () => {
    const typed = serializeError(new ValidationError('Bad profile.'));
    expect(typed).toMatchObject({
      code: ERROR_CODES.VALIDATION,
      name: 'ValidationError',
      message: 'Bad profile.',
      details: [],
    });

    const unknown = serializeError(new Error('boom'));
    expect(unknown.code).toBe(ERROR_CODES.INTERNAL);
    expect(unknown.message).toBe('boom');
  });
});
