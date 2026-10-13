#!/usr/bin/env bun
// Checks every skill's frontmatter and local references, the runtime-neutral Claude export, and that
// the Codex and Claude skill lists and instructions only name skills that exist.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RUNTIME_SPECIFIC = /\b(?:Pi|Codex|Claude)\b|\.pi\/|\.codex\/|pi-subagents|workflowScript|web_search|project_validate|privileged_operation|lsp_diagnostics/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const failures: string[] = [];
const fail = (message: string) => failures.push(message);

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".md")).map(name => join(directory, name));
}

// A link inside an instruction folder hides what a runtime loads, and following one can leave the
// repository, so look for links first without following them, and stop before any other walk.
const SKILL_ROOTS = ["skills", "claude/skills", ".agents/skills"];
const INSTRUCTION_ROOTS = [...SKILL_ROOTS, "claude/agents", "pi/prompts", "docs"];
const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return lstatSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });
const instructionPaths = INSTRUCTION_ROOTS.filter(root => existsSync(join(ROOT, root)) && !lstatSync(join(ROOT, root)).isSymbolicLink()).flatMap(root => walk(join(ROOT, root)).map(path => ({ root, path, name: relative(join(ROOT, root), path) })));
const links = [
  ...INSTRUCTION_ROOTS.map(root => join(ROOT, root)).filter(path => existsSync(path) && lstatSync(path).isSymbolicLink()).map(path => ({ path })),
  ...instructionPaths.filter(({ path }) => lstatSync(path).isSymbolicLink()),
];
if (links.length > 0) {
  for (const { path } of links) console.error(`${relative(ROOT, path)}: a link inside an instruction folder hides what a runtime loads; replace it with the file or folder it points to`);
  process.exit(1);
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
if (existsSync(join(ROOT, ".agents/skills"))) for (const directory of skillDirectories(".agents/skills")) checkSkill(directory);

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

// Subagent roles: claude/agents/*.md is the only place that binds a model. The roles the instructions
// name and the role files must match, so neither can drift from the other.
const MODEL_ID = /\b(?:claude-(?:opus|sonnet|haiku|fable)-\d|gpt-\d)/;
const ROLE_MODELS = new Set(["claude-haiku-5-5", "claude-opus-5-5"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const roles = new Set<string>();
for (const entry of readdirSync(join(ROOT, "claude/agents")).filter(name => name.endsWith(".md"))) {
  const path = `claude/agents/${entry}`;
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(ROOT, path), "utf8"))?.[1];
  if (!frontmatter) { fail(`${path}: missing frontmatter`); continue; }
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
  const name = field("name"), model = field("model"), effort = field("effort");
  if (!name || !field("description")) fail(`${path}: needs name and description`);
  if (!model || !ROLE_MODELS.has(model)) fail(`${path}: model must be one of ${[...ROLE_MODELS].join(", ")}`);
  if (!effort || !EFFORTS.has(effort)) fail(`${path}: effort must be one of ${[...EFFORTS].join(", ")}`);
  // An exact comma-separated list of tool names, so quoting, flow collections, or a rule such as Read(Agent) cannot
  // stand in for denying the Agent tool.
  if (!/^disallowedTools: (?:[A-Z][A-Za-z]*, )*Agent(?:, [A-Z][A-Za-z]*)*$/m.test(frontmatter)) fail(`${path}: write disallowedTools as a comma-separated list of tool names that includes Agent; children do not launch children`);
  if (name && roles.has(name)) fail(`${path}: a second role file named ${name}`);
  if (name) roles.add(name);
}
const roleLine = instructions.split("\n").find(line => line.startsWith("- Launch children by role"));
const named = new Set([...(roleLine ?? "").matchAll(/`([A-Za-z]+(?:-[a-z]+)*)`/g)].map(match => match[1]!));
// Other hyphenated names in backticks are skill references.
for (const match of instructions.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
  if (!exported.has(match[1]!) && !roles.has(match[1]!)) fail(`claude/CLAUDE.md references an unexported skill: ${match[1]}`);
}
if (!roleLine) fail("claude/CLAUDE.md: missing the line starting '- Launch children by role'");
for (const role of named) if (!roles.has(role)) fail(`claude/CLAUDE.md names role ${role}; add claude/agents/<file>.md with name: ${role}`);
for (const role of roles) if (!named.has(role)) fail(`claude/agents defines role ${role}; name it in the role line of claude/CLAUDE.md`);
for (const document of [join(ROOT, "claude/CLAUDE.md"), ...markdownFiles(join(ROOT, "skills")), ...markdownFiles(join(ROOT, "claude/skills"))]) {
  if (MODEL_ID.test(readFileSync(document, "utf8"))) fail(`${relative(ROOT, document)}: names a model; bind models only in claude/agents/*.md`);
}

// Instruction text must not run commands or grant permissions. A runtime runs inline shell (!`command`) and
// fenced blocks opened with ```! before the model reads a skill, honors frontmatter such as allowed-tools,
// hooks, or permissionMode, and loads a nested .claude/skills folder as another skill root. Each of those
// fails here, so such a change cannot pass review as text.
const ALLOWED_KEYS = {
  skill: new Set(["name", "description", "disable-model-invocation"]),
  role: new Set(["name", "description", "model", "effort", "tools", "disallowedTools"]),
  prompt: new Set(["description", "argument-hint"]),
};
const INLINE_SHELL = /!`/;
// Unanchored: the runtime finds a fence opened with ! anywhere in the text, not only at a line start.
const FENCED_SHELL = /(?:```|~~~)!/;
const PLAIN_FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
// Names compare case-insensitively, as the runtime finds .claude/skills and SKILL.md on a case-insensitive disk.
const SKILL_FILE = /(?:^|\/)skill\.md$/i;
const instructionFiles = instructionPaths.filter(({ path }) => lstatSync(path).isFile());
for (const { root, name, path } of instructionFiles) {
  const where = relative(ROOT, path);
  if (name.toLowerCase().split("/").includes(".claude")) fail(`${where}: a nested .claude folder is loaded as its own skill root; move the file out of it`);
  if (SKILL_ROOTS.includes(root) && SKILL_FILE.test(name) && name.split("/").length !== 2) fail(`${where}: a SKILL.md below a skill's top folder is loaded as its own skill; keep one SKILL.md per <root>/<name>/`);
  if (!/\.md$/i.test(name)) continue;
  const text = readFileSync(path, "utf8");
  // YAML reads a lone carriage return or a Unicode line separator as a line break, and other control characters
  // change how it parses, so instruction Markdown uses LF line endings and no control characters but tab.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]/.test(text)) fail(`${where}: use LF line endings and no control characters (no carriage returns, form feeds, or Unicode line separators), so a runtime reads the same lines this checker does`);
  if (INLINE_SHELL.test(text) || FENCED_SHELL.test(text)) fail(`${where}: inline shell (!\`...\` or a fence opened with !) runs before the model reads the file; put the command in a script and name the script, or to document the syntax, separate the ! from the backtick`);
  const opening = text.replace(/^\uFEFF/, "");
  if (/^---\s*\n/.test(opening) && !PLAIN_FRONTMATTER.test(text)) fail(`${where}: write frontmatter in the plain form (no byte-order mark, no trailing spaces after ---, LF line endings) so this checker reads every key`);
  const kind = SKILL_FILE.test(name) && SKILL_ROOTS.includes(root) ? "skill" : root === "claude/agents" ? "role" : root === "pi/prompts" ? "prompt" : undefined;
  if (kind === undefined) continue;
  const allowed = ALLOWED_KEYS[kind];
  // Every frontmatter line must be one top-level key: value line with no comment, and no key may repeat. The
  // runtime parses frontmatter as YAML, and YAML can only see a top-level key that starts a line at column 0, so
  // it never sees a key these lines miss; a comment or a repeated key would change a value it reads.
  const block = PLAIN_FRONTMATTER.exec(text)?.[1];
  if (block === undefined) continue;
  const lines = block.split("\n");
  // A value is a quoted string closed on its own line or text starting with a letter or digit, with no ---,
  // which a runtime takes as the end of the frontmatter and would drop every key after it.
  const odd = lines.filter(line => !/^[A-Za-z][A-Za-z0-9_-]*: (?:"[^"\\]*"|'[^']*'|[A-Za-z0-9].*)$/.test(line) || /\s#/.test(line) || line.includes("---"));
  if (odd.length > 0) {
    fail(`${where}: every frontmatter line must be a single top-level key: value line, its value a quoted string closed on the line or text starting with a letter or digit, without a # comment or --- (found ${JSON.stringify(odd[0])})`);
    continue;
  }
  const keys = lines.map(line => line.slice(0, line.indexOf(":")));
  // The runtime parses the block as YAML and, if that throws, falls back to an empty frontmatter, which would
  // silently drop keys such as disable-model-invocation. Require the block to parse on its own, to exactly these keys.
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(block);
  } catch {
    parsed = undefined;
  }
  const parsedKeys = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : undefined;
  if (parsedKeys === undefined || parsedKeys.length !== new Set(keys).size || !keys.every(key => parsedKeys.includes(key))) {
    fail(`${where}: frontmatter must parse as YAML on its own to exactly its key lines; quote a value that contains ": ", ends in ":", or holds a backslash or quote`);
    continue;
  }
  // Check the values the runtime reads, not the raw text: it ignores a flag that is not a real boolean and drops a
  // role whose name or description is not a non-empty string.
  const values = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" && typeof value !== "boolean") fail(`${where}: frontmatter ${key} must be text or true/false (YAML read ${JSON.stringify(value)})`);
  }
  if ("disable-model-invocation" in values && typeof values["disable-model-invocation"] !== "boolean") fail(`${where}: disable-model-invocation must be true or false, unquoted`);
  for (const key of ["name", "description"]) {
    if (key in values && (typeof values[key] !== "string" || (values[key] as string).trim() === "")) fail(`${where}: ${key} must be non-empty text`);
  }
  if (kind === "skill") {
    const directory = name.split("/")[0];
    if (values.name !== directory) fail(`${where}: name must be exactly ${directory}, its directory, as the runtime reads it (YAML read ${JSON.stringify(values.name)})`);
    if (typeof values.description === "string" && values.description.length > 1024) fail(`${where}: description must be at most 1024 characters as the runtime reads it`);
  }
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) fail(`${where}: frontmatter key "${repeated}" appears twice; a runtime keeps only one of them`);
  for (const key of keys) {
    if (!allowed.has(key)) fail(`${where}: frontmatter key "${key}" is not allowed (allowed: ${[...allowed].join(", ")}); keys that grant tools, hooks, or permissions belong in reviewed configuration, not instruction text`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`skills ok: ${shared.size} shared, ${exported.size} exported to Claude`);
