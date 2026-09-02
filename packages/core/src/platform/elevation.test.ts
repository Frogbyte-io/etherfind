import { describe, expect, it } from "vitest";
import { buildUacCommand } from "./elevation.js";

/** Extracts and decodes the -EncodedCommand payload handed to the elevated shell. */
function decodePayload(command: string): string {
  const match = command.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/);
  if (!match?.[1]) throw new Error(`no encoded command in: ${command}`);
  return Buffer.from(match[1], "base64").toString("utf16le");
}

describe("buildUacCommand", () => {
  const argv = ["powershell.exe", "-NoProfile", "-Command", "netsh interface ipv4 show interface"];

  // Regression: the payload used to be JSON.stringify(argv), so the elevated
  // shell received ["powershell.exe",...] and died with "Missing type name
  // after '['" — meaning no elevated command ever ran on Windows.
  it("encodes an executable PowerShell script, not a JSON array", () => {
    const payload = decodePayload(buildUacCommand(argv, "C:/tmp/o.txt", "C:/tmp/e.txt"));
    expect(payload).not.toContain('["powershell.exe"');
    expect(payload).toContain("& 'powershell.exe' '-NoProfile' '-Command'");
    expect(payload).toContain("'netsh interface ipv4 show interface'");
  });

  it("redirects both streams so elevated failures are visible", () => {
    const payload = decodePayload(buildUacCommand(argv, "C:/tmp/o.txt", "C:/tmp/e.txt"));
    expect(payload).toContain("> 'C:/tmp/o.txt'");
    expect(payload).toContain("2> 'C:/tmp/e.txt'");
  });

  it("propagates the elevated exit code back to the caller", () => {
    const command = buildUacCommand(argv, "C:/tmp/o.txt", "C:/tmp/e.txt");
    expect(decodePayload(command)).toContain("exit $LASTEXITCODE");
    expect(command).toContain("-Verb RunAs -Wait -PassThru");
    expect(command).toContain("exit $p.ExitCode");
  });

  it("escapes single quotes so an argument cannot break out of its literal", () => {
    const payload = decodePayload(
      buildUacCommand(["netsh", "it's here'; calc.exe #"], "C:/tmp/o.txt", "C:/tmp/e.txt"),
    );
    expect(payload).toContain("'it''s here''; calc.exe #'");
    expect(payload).not.toContain("'; calc.exe #'\n");
  });
});
