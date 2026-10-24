import { REGISTRY_MODS_ROOT, type RegistryOp } from '@shared/domain';
import { ValidationError } from '@shared/errors';

export const APPLY_ROOT_VALUE_NAMES: ReadonlySet<string> = new Set([
  'disabled',
  'settingschangetime',
]);

function isModRootPath(path: string): boolean {
  const suffix = path.slice(REGISTRY_MODS_ROOT.length + 1);
  return suffix.length > 0 && !suffix.includes('\\');
}

export function assertApplyOpsAllowed(ops: readonly RegistryOp[]): void {
  for (const operation of ops) {
    if (
      isModRootPath(operation.path) &&
      !APPLY_ROOT_VALUE_NAMES.has(operation.name.toLowerCase())
    ) {
      throw new ValidationError(
        `Apply operations may write only Disabled, SettingsChangeTime, or values under Settings; "${operation.name}" is not allowed at the mod root.`,
      );
    }
  }
}
