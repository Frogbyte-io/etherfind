import { execFile } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

/** Runs a command without a shell; argv-array only (injection-safe). */
export function runFile(command: string, args: string[], timeoutMs = 15000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error);
          return;
        }
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
  });
}

export const POWERSHELL = "powershell.exe";
