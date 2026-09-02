import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Quotes a value as a PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds the (non-elevated) PowerShell command that launches `argv` elevated.
 *
 * The elevated child is handed a base64 `-EncodedCommand` containing a real
 * PowerShell script — encoding the *argv array* instead produces
 * `["powershell.exe",...]`, which PowerShell rejects with
 * "Missing type name after '['", so no elevated command ever ran.
 *
 * `-Verb RunAs` forces ShellExecute, which cannot be combined with
 * `-RedirectStandardOutput`, so the elevated script redirects its own streams
 * to files that the caller reads back; otherwise netsh failures are invisible.
 */
export function buildUacCommand(argv: string[], outPath: string, errPath: string): string {
  const invocation = argv.map(psQuote).join(" ");
  const inner = [
    `& ${invocation} > ${psQuote(outPath)} 2> ${psQuote(errPath)}`,
    "exit $LASTEXITCODE",
  ].join("\n");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru`,
    "exit $p.ExitCode",
  ].join("; ");
}

/** Reads a file written by PowerShell, whose redirection encoding varies. */
function readRedirected(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const buffer = readFileSync(path);
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
      return buffer.subarray(3).toString("utf8");
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    rmSync(path, { force: true });
  }
}

export class UacElevator implements Elevator {
  readonly description = "UAC elevation";

  /**
   * Runs argv elevated through PowerShell's Start-Process -Verb RunAs,
   * triggering a UAC prompt, and maps the elevated process exit code and
   * output back to the unprivileged caller.
   */
  async run(argv: string[]): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("Empty argv for elevated operation");
    const id = randomUUID();
    const outPath = join(tmpdir(), `etherfind-${id}.out`);
    const errPath = join(tmpdir(), `etherfind-${id}.err`);
    const command = buildUacCommand(argv, outPath, errPath);

    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        },
      );
      void collect(child).then(resolve, reject);
    });

    const stdout = readRedirected(outPath);
    const stderr = readRedirected(errPath);
    if (result.code !== 0 && /canceled|cancelled|denied/i.test(result.stderr)) {
      return {
        stdout,
        stderr: `${stderr || result.stderr}\nElevation was declined by the user.`,
        code: result.code,
      };
    }
    return { stdout, stderr: stderr || result.stderr, code: result.code };
  }
}
