// The validate action runs the repository's one validate entry point from the repository root.
// A stub bash runtime runs commands with /bin/sh, so this needs no pinned Pi runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { loadExtension } from "./extension-fixture.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-validate-action-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const stub = join(scratch, "bash-stub.mjs");
writeFileSync(stub, `import { spawnSync } from "node:child_process";
export function createLocalBashOperations() {
  return { async exec(command, cwd, options) {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd, timeout: options.timeout * 1000 });
    options.onData(Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]));
    return { exitCode: result.status };
  } };
}
`);
const tool = (await loadExtension("project-validate", { bashRuntime: pathToFileURL(stub).href }))().get("project_validate");
const run = (cwd, extra = {}) => tool.execute("test", { action: "validate", cwd, timeoutMs: 5000, ...extra }, undefined, undefined, { cwd });

function repository(name) {
  const root = join(scratch, name);
  mkdirSync(root);
  assert.equal(spawnSync("git", ["-C", root, "init", "-q", "-b", "main"]).status, 0);
  return root;
}

test("validate runs scripts/validate from the repository root, not the nearest project marker", async () => {
  const root = repository("with-validate");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/validate"), "#!/bin/sh\nprintf 'validated in %s\\n' \"$PWD\"\n", { mode: 0o755 });
  const nested = join(root, "packages/app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), "{}");
  const result = await run(nested);
  assert.equal(result.details.outcome, "passed");
  assert.equal(result.details.command, "scripts/validate");
  assert.equal(result.details.cwd, root);
  assert.match(result.content[0].text, new RegExp(`Output:\\nvalidated in ${root}$`));
});

test("validate reports a failing entry point as failed with its exit status", async () => {
  const root = repository("failing");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/validate"), "#!/bin/sh\necho 'lint failed' >&2\nexit 3\n", { mode: 0o755 });
  const result = await run(root);
  assert.equal(result.details.outcome, "failed");
  assert.equal(result.details.exitCode, 3);
});

test("without scripts/validate, validate is unsupported and names the AGENTS.md command", async () => {
  const root = repository("without-validate");
  writeFileSync(join(root, "package.json"), "{}");
  const result = await run(root);
  assert.equal(result.details.outcome, "unsupported");
  assert.match(result.content[0].text, /No scripts\/validate within .*AGENTS\.md/);
});

test("an explicit validate command runs from the repository root, not the nearest project marker", async () => {
  const root = repository("explicit");
  const nested = join(root, "sub");
  mkdirSync(nested);
  writeFileSync(join(nested, "package.json"), "{}");
  const result = await run(nested, { command: "pwd" });
  assert.equal(result.details.outcome, "passed");
  assert.equal(result.details.cwd, root);
  assert.match(result.content[0].text, new RegExp(`Output:\\n${root}`));
});
