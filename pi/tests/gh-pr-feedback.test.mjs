import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import * as core from "../../agentic/tools/pr-feedback/pr-feedback.ts";

// The adapter runs with the real shared collector; only Pi's Type builder and the gh runner are
// stubbed, so the test pins the tool's contract without a network.
const stripTypeScriptTypes = (source) => new Bun.Transpiler({ loader: "ts" }).transformSync(source);
const source = stripTypeScriptTypes(readFileSync(new URL("../extensions/gh-pr-feedback.ts", import.meta.url), "utf8")
  .replace('import { Type } from "@mariozechner/pi-ai";', "")
  .replace(/import \{[^}]+\} from "\.\.\/\.\.\/agentic\/tools\/pr-feedback\/pr-feedback\.ts";/, "")
  .replace(/export default function \w*/, "function register"));

const Type = { Object: (properties) => ({ properties }), Optional: (schema) => schema, Number: () => ({}), String: () => ({}), Boolean: () => ({}) };
const SHA = "b".repeat(40);
const ok = (value) => ({ ok: true, stdout: JSON.stringify(value) });

function fakeRunner(cwds) {
  return (cwd) => {
    cwds.push(cwd);
    return {
      git: async () => ({ ok: true, stdout: "feature\n" }),
      gh: async (args) => {
        if (args[0] === "repo") return ok({ nameWithOwner: "o/r" });
        if (args[0] === "pr" && args[1] === "list") return ok([]);
        if (args[0] === "pr" && args[1] === "view" && args[2] === "7") return ok({ number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", baseRefName: "main", headRefName: "feature", headRefOid: SHA, changedFiles: 0, files: [] });
        if (args[0] === "pr" && args[1] === "view") return { ok: false, error: "no pull requests found" };
        if (args[1] === "graphql") return ok({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, reviews: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
        if (args[1].includes("/check-runs?")) return ok({ total_count: 1, check_runs: [{ id: 5, name: "build", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/runs/5", output: { annotations_count: 0 } }] });
        if (args[1].includes("/status?")) return ok({ state: "pending", total_count: 0, statuses: [] });
        return { ok: false, error: `unexpected gh ${args.join(" ")}` };
      },
    };
  };
}

function loadTool() {
  const cwds = [];
  const register = vm.runInNewContext(`${source}\nregister;`, { ...core, Type, processRunner: fakeRunner(cwds) });
  const tools = new Map();
  register({ registerTool: (tool) => tools.set(tool.name, tool) });
  return { tool: tools.get("gh_pr_feedback"), cwds };
}

test("the tool keeps its name and parameters", () => {
  const { tool } = loadTool();
  assert.deepEqual(Object.keys(tool.parameters.properties), ["number", "repo", "includeResolved", "includeOutdated", "includeAnnotations", "limit"]);
});

test("the tool renders the shared collector's text and details for the cwd", async () => {
  const { tool, cwds } = loadTool();
  const result = await tool.execute("id", { number: 7, repo: "o/r" }, undefined, undefined, { cwd: "/work" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(cwds, ["/work"]);
  assert.match(result.content[0].text, /^# PR #7: T\nhttps:\/\/github.com\/o\/r\/pull\/7\nState: needs local changes: failing checks\n/);
  assert.match(result.content[0].text, /Review decision: none/);
  assert.deepEqual({ ...result.details }, { number: 7, repo: "o/r", threadReadError: undefined, checkCount: 1, annotationCount: 0 });
});

test("a missing PR and a negative number are tool errors", async () => {
  const { tool } = loadTool();
  const missing = await tool.execute("id", {}, undefined, undefined, { cwd: "/work" });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, 'gh_pr_feedback could not find PR: no pull request found for branch "feature" in o/r (no pull requests found); pass a PR number or URL');
  const negative = await tool.execute("id", { number: -3 }, undefined, undefined, { cwd: "/work" });
  assert.equal(negative.isError, true);
  assert.equal(negative.content[0].text, "gh_pr_feedback failed to read PR: -3 is not a PR number");
});
