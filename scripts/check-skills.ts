#!/usr/bin/env bun
// Checks every skill's frontmatter and local references, the runtime-neutral Claude export, and that
// the Codex and Claude skill lists and instructions only name skills that exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RUNTIME_SPECIFIC = /\b(?:Pi|Codex|Claude)\b|\.pi\/|\.codex\/|pi-subagents|workflowScript|web_search|project_validate|privileged_operation|lsp_diagnostics/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const failures: string[] = [];
const fail = (message: string) => failures.push(message);

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".md")).map(name => join(directory, name));
}

function checkSkill(directory: string): string | undefined {
  const path = join(directory, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return void fail(`${relative(ROOT, path)}: missing frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    if (!line || /^\s/.test(line) || !line.includes(":")) continue;
    const at = line.indexOf(":");
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, ""));
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  const directoryName = directory.split("/").pop()!;
  if (!NAME.test(name) || name.length > 64) fail(`${relative(ROOT, path)}: invalid name "${name}"`);
  if (name !== directoryName) fail(`${relative(ROOT, path)}: name does not match directory ${directoryName}`);
  if (description.length < 1 || description.length > 1024) fail(`${relative(ROOT, path)}: description must be 1..1024 characters`);
  const invocation = fields.get("disable-model-invocation");
  if (invocation !== undefined && !["true", "false"].includes(invocation)) fail(`${relative(ROOT, path)}: invalid disable-model-invocation`);
  for (const document of markdownFiles(directory)) {
    for (const reference of readFileSync(document, "utf8").matchAll(/`(references\/[^`]+)`|\]\((references\/[^)]+)\)/g)) {
      const target = reference[1] ?? reference[2]!;
      if (!existsSync(join(directory, target))) fail(`${relative(ROOT, document)}: missing reference ${target}`);
    }
  }
  return name;
}

const skillDirectories = (root: string) => readdirSync(join(ROOT, root)).map(name => join(ROOT, root, name)).filter(path => statSync(path).isDirectory() && existsSync(join(path, "SKILL.md")));
const shared = new Set<string>();
for (const directory of skillDirectories("skills")) {
  const name = checkSkill(directory);
  if (name !== undefined && shared.has(name)) fail(`duplicate skill ${name}`);
  if (name !== undefined) shared.add(name);
}
for (const directory of skillDirectories("claude/skills")) checkSkill(directory);

for (const name of readFileSync(join(ROOT, "codex/skills.txt"), "utf8").split("\n").filter(Boolean)) {
  if (!shared.has(name)) fail(`codex/skills.txt names a missing skill: ${name}`);
}

// Claude's export must stay runtime-neutral: it is loaded outside Pi and Codex.
const exported = new Set<string>();
for (const entry of readFileSync(join(ROOT, "claude/skills.txt"), "utf8").split("\n").filter(Boolean)) {
  if (!/^(?:claude\/)?skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry)) { fail(`claude/skills.txt: malformed entry ${entry}`); continue; }
  const directory = join(ROOT, entry);
  if (!existsSync(join(directory, "SKILL.md"))) { fail(`claude/skills.txt names a missing skill: ${entry}`); continue; }
  const name = entry.split("/").pop()!;
  if (exported.has(name)) fail(`claude/skills.txt exports ${name} twice`);
  exported.add(name);
  for (const document of markdownFiles(directory)) {
    if (RUNTIME_SPECIFIC.test(readFileSync(document, "utf8"))) fail(`${relative(ROOT, document)}: runtime-specific wording in a Claude export`);
  }
}
const instructions = readFileSync(join(ROOT, "claude/CLAUDE.md"), "utf8");
if (RUNTIME_SPECIFIC.test(instructions)) fail("claude/CLAUDE.md: runtime-specific wording");
for (const match of instructions.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
  if (!exported.has(match[1]!)) fail(`claude/CLAUDE.md references an unexported skill: ${match[1]}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`skills ok: ${shared.size} shared, ${exported.size} exported to Claude`);
