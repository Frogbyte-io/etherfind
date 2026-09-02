import { spawn } from "node:child_process";
import type { ExecResult } from "./exec.js";

/**
 * Runs a single narrowly scoped command with elevation. The npm process itself
 * never gains privileges: on Linux a short-lived `sudo` child is used, on
 * Windows a UAC-elevated child via `Start-Process -Verb RunAs`.
 */
export interface Elevator {
  readonly description: string;
  run(argv: string[]): Promise<ExecResult>;
}

function collect(child: ReturnType<typeof spawn>): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

export class SudoElevator implements Elevator {
  readonly description = "sudo";

  /**
   * Runs `sudo -- <argv...>` with stdio inherited so the user can enter their
   * password in the terminal. Args must be a pre-validated argv array; no
   * shell is involved.
   */
  run(argv: string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("sudo", ["--", ...argv], {
        stdio: ["inherit", "pipe", "pipe"],
        shell: false,
      });
      void collect(child).then(resolve, reject);
    });
  }
}

export class UacElevator implements Elevator {
  readonly description = "UAC elevation";

  /**
   * Runs argv elevated through PowerShell's Start-Process -Verb RunAs,
   * triggering a UAC prompt, and maps the elevated process exit code back.
   */
  run(argv: string[]): Promise<ExecResult> {
    const encoded = Buffer.from(JSON.stringify(argv), "utf16le").toString("base64");
    const command = `$p = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        },
      );
      void collect(child).then((result) => {
        if (result.code !== 0 && /canceled|cancelled|denied/i.test(result.stderr)) {
          resolve({ ...result, stderr: `${result.stderr}\nElevation was declined by the user.` });
          return;
        }
        resolve(result);
      }, reject);
    });
  }
}
