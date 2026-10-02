import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "bun:test";

// The extension's model calls go to a stub; Pi supplies the real module at runtime.
const piAiStub = await import("../scripts/test-pi-ai-stub.mjs");
mock.module("@mariozechner/pi-ai", () => piAiStub);

const { runCopy } = await import("../extensions/copy.ts");
test("runCopy sends text and file contents to the clipboard command", async () => {
const testDir = await mkdtemp(join(tmpdir(), "pi-copy-test-"));
const clipboardPath = join(testDir, "clipboard");
const copyPath = join(testDir, "copy");
const waylandSocketPath = join(testDir, "wayland-1");
const waylandServer = createServer();

try {
	await new Promise((resolve, reject) => {
		waylandServer.once("error", reject);
		waylandServer.listen(waylandSocketPath, resolve);
	});
	await writeFile(
		copyPath,
		"#!/usr/bin/env bash\n[[ \"$WAYLAND_DISPLAY\" == \"wayland-1\" ]] || { printf 'wrong WAYLAND_DISPLAY: %s\\n' \"$WAYLAND_DISPLAY\" >&2; exit 1; }\n[[ \"$1\" == \"--\" && -f \"$2\" ]] || exit 2\ncontent=\"$(cat \"$2\")\"; content=\"${content#\"${content%%[![:space:]]*}\"}\"; printf '%s' \"${content%\"${content##*[![:space:]]}\"}\" > \"$PI_COPY_TEST_CLIPBOARD\"\n",
		{ mode: 0o700 },
	);
	await chmod(copyPath, 0o700);
	await writeFile(join(testDir, ".zshrc"), 'export PATH="$PI_COPY_TEST_BIN:$PATH"\n');

	const pi = {
		exec(command, args, options = {}) {
			return new Promise((resolve) => {
				const child = spawn(command, args, {
					cwd: options.cwd,
					env: {
						...process.env,
						PATH: `${testDir}:${process.env.PATH}`,
						PI_COPY_TEST_CLIPBOARD: clipboardPath,
						PI_COPY_TEST_BIN: testDir,
						ZDOTDIR: testDir,
						WAYLAND_DISPLAY: "",
						XDG_RUNTIME_DIR: testDir,
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1, killed: false }));
			});
		},
	};

	const text = " copy this exact payload ";
	await runCopy(pi, "text", text);
	assert.equal(await readFile(clipboardPath, "utf8"), "copy this exact payload");

	const sourcePath = join(testDir, "source.txt");
	await writeFile(sourcePath, " file contents\n");
	await runCopy(pi, "file", sourcePath);
	assert.equal(await readFile(clipboardPath, "utf8"), "file contents");

	await assert.rejects(runCopy(pi, "file", join(testDir, "missing.txt")));
	assert.equal(await readFile(clipboardPath, "utf8"), "file contents");
} finally {
	await new Promise((resolve, reject) => {
		waylandServer.close((error) => error ? reject(error) : resolve());
	});
	await rm(testDir, { recursive: true, force: true });
}
});
