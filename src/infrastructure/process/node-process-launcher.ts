import { spawn } from 'node:child_process';
import type { ProcessLauncher } from '@core/process/process-launcher';
import { EnvironmentError } from '@shared/errors';

export class NodeProcessLauncher implements ProcessLauncher {
  launch(executable: string, args: readonly string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      let settled = false;

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new EnvironmentError(`Failed to start ${executable}.`, { cause: error }));
      });

      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      });
    });
  }
}
