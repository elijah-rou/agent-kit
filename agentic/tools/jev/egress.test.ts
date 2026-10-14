import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot, commonDir, httpClassifier, isPublic, isTask, MAX_TASK_CHARS, OPT_OUT_FILE, promptOrigin, repoOf, screen, sendable, type FetchLike } from "./egress.ts";
import { QUESTIONS, type Sendable } from "./route.ts";
import { seededCache } from "./testing.ts";

describe("what leaves the machine", () => {
	test("short follow-ups are not tasks", () => {
		expect(isTask("yes, continue")).toBe(false);
		expect(isTask("Change the launcher's languages subcommand to a flag")).toBe(true);
	});

	test("credential-shaped text is never sent, and home directories are redacted", () => {
		expect(sendable(`rotate the key ${"sk-" + "a".repeat(24)} in config`)).toBeUndefined();
		expect(sendable(`use ${"ghp_" + "b".repeat(30)}`)).toBeUndefined();
		expect(sendable("set password=hunter2hunter2 in the env file")).toBeUndefined();
		const typesafe = "apikey_" + "0".repeat(34) + "_" + "c".repeat(64);
		expect(sendable(`use the jev api directly, I have an api key: ${typesafe}`)).toBeUndefined();
		expect(sendable(`here it is ${typesafe}`)).toBeUndefined();
		expect(sendable(`configure Jev with _${typesafe}_ for this project`)).toBeUndefined();
		expect(sendable("the api  key: abcd1234efgh5678 for staging")).toBeUndefined();
		expect(sendable("my api key: abcdefgh12345678 for staging")).toBeUndefined();
		for (const secret of ["sk_" + "live_" + "a".repeat(24), "npm_" + "b".repeat(36), "glpat-" + "c".repeat(20), "Bearer " + "d".repeat(32), "postgres://" + "admin:" + "s3cretpw" + "@db.internal:5432/app"]) {
			expect(sendable(`connect the worker with ${secret} before deploying`)).toBeUndefined();
		}
		expect(sendable("point the worker at postgres://db.internal:5432/app and https://example.com/docs")).toBe("point the worker at postgres://db.internal:5432/app and https://example.com/docs");
		expect(sendable("rename the token parser module and update its callers")).toBe("rename the token parser module and update its callers");
		expect(sendable("document the apikey_ prefix rule and the api key rotation steps")).toBe("document the apikey_ prefix rule and the api key rotation steps");
		const [mac, linux] = ["/" + "Users/someone", "/" + "home/dev"];
		expect(sendable(`fix the build script in ${mac}/src/app and ${linux}/x`)).toBe("fix the build script in ~/src/app and ~/x");
	});

	test("a future-dated or failed cache entry is not trusted as public", async () => {
		const future = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() + 10 * 86_400_000 });
		expect(await isPublic("o/r", { env: future, timeoutMs: 0 })).toBe(false);
		const failed = seededCache("o/r", { visibility: "UNKNOWN", at: Date.now() });
		expect(await isPublic("o/r", { env: failed, timeoutMs: 0 })).toBe(false);
		const fresh = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() });
		expect(await isPublic("o/r", { env: fresh, timeoutMs: 0 })).toBe(true);
		expect(await isPublic("o/r", { env: fresh, fresh: true, timeoutMs: 0 })).toBe(false);
	});
});

describe("the task screen", () => {
	const anywhere = { origin: "user", optedOut: false } as const;

	test("sends a task-sized prompt, redacted, and withholds everything else with its reason", () => {
		expect(screen(`  Migrate the ledger store to SQLite under ${"/" + "Users/someone"}/app  `, anywhere)).toEqual({ kind: "send", text: "Migrate the ledger store to SQLite under ~/app" as Sendable });
		expect(screen("yes, continue", anywhere)).toEqual({ kind: "withhold", reason: "not-a-task" });
		expect(screen(`Fix the build from this log: ${"x".repeat(MAX_TASK_CHARS)}`, anywhere)).toEqual({ kind: "withhold", reason: "unsafe-input" });
		expect(screen(`rotate the deploy token ${"ghp_" + "c".repeat(30)} today please`, anywhere)).toEqual({ kind: "withhold", reason: "unsafe-input" });
		expect(screen("Migrate the ledger store to SQLite now", { origin: "user", optedOut: true })).toEqual({ kind: "withhold", reason: "opted-out" });
		expect(screen("Migrate the ledger store to SQLite now", { origin: "child", optedOut: false })).toEqual({ kind: "withhold", reason: "child" });
		expect(screen("Migrate the ledger store to SQLite now", { origin: "extension", optedOut: false })).toEqual({ kind: "withhold", reason: "extension" });
		expect(screen("Migrate the ledger store to SQLite now", { origin: "system", optedOut: false })).toEqual({ kind: "withhold", reason: "system" });
	});

	test("turns the runtime starts are system prompts; a user mentioning them is not", () => {
		expect(promptOrigin("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>")).toBe("system");
		expect(promptOrigin("\n  <task-notification>\n<task-id>b1</task-id>")).toBe("system");
		expect(promptOrigin("Delegated task node:delegated-task:command%3Amcp%3Ax reached a terminal state. Use task_status with taskId x.")).toBe("system");
		expect(promptOrigin("Why did the <task-notification> for the build arrive twice?")).toBe("user");
		expect(promptOrigin("Delegated task review: please check the reviewer's findings")).toBe("user");
		expect(promptOrigin("Migrate the ledger store to SQLite now")).toBe("user");
	});

	test("a prompt at the length limit is still sent", () => {
		const prompt = `Fix the build ${"y".repeat(MAX_TASK_CHARS - 20)} a b c`;
		expect(prompt.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
		expect(screen(prompt, anywhere).kind).toBe("send");
	});
});

describe("the repository a prompt was typed in", () => {
	function checkout(optOut: boolean): { root: string; nested: string } {
		const root = mkdtempSync(join(tmpdir(), "jev-repo-"));
		mkdirSync(join(root, ".git"));
		const nested = join(root, "src", "deep");
		mkdirSync(nested, { recursive: true });
		if (optOut) {
			mkdirSync(join(root, ".agents"));
			writeFileSync(join(root, OPT_OUT_FILE), "");
		}
		return { root, nested };
	}

	test("the opt-out file at the checkout root covers every directory below it", async () => {
		const opted = checkout(true);
		expect(checkoutRoot(opted.nested)).toBe(opted.root);
		expect(await repoOf(opted.nested, 1000)).toMatchObject({ optedOut: true });
		const open = checkout(false);
		expect(await repoOf(open.nested, 1000)).toMatchObject({ optedOut: false });
	});

	test("each checkout without a GitHub origin is its own bucket, shared by its worktrees", async () => {
		const git = (cwd: string, ...args: string[]) => {
			const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		};
		const clone = (): string => {
			const root = mkdtempSync(join(tmpdir(), "jev-local-"));
			git(root, "init", "-q");
			git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
			return root;
		};
		const first = clone();
		const second = clone();
		const worktree = join(mkdtempSync(join(tmpdir(), "jev-worktree-")), "wt");
		git(first, "worktree", "add", "-q", worktree);
		const [a, b, w] = await Promise.all([repoOf(first, 1000), repoOf(second, 1000), repoOf(join(worktree, "."), 1000)]);
		expect(a.slug).toMatch(/^other:[0-9a-f]{16}$/);
		expect(b.slug).toMatch(/^other:[0-9a-f]{16}$/);
		expect(a.slug).not.toBe(b.slug);
		expect(w.slug).toBe(a.slug);
		expect(commonDir(worktree)).toBe(commonDir(first));
		expect(`${a.slug}${b.slug}`).not.toContain("jev-local");
	});

	test("a directory outside any checkout is sent as repository none", async () => {
		const outside = mkdtempSync(join(tmpdir(), "jev-outside-"));
		expect(checkoutRoot(outside)).toBeUndefined();
		expect(await repoOf(outside, 1000)).toEqual({ slug: "none", optedOut: false });
	});
});

describe("Jev over HTTP", () => {
	const state = { task: "Migrate the ledger store to SQLite" as Sendable };
	const answer = {
		door: { type: "choice", choice: "one-way-door", confidence: 0.99, probabilities: { reversible: 0, experiment: 0.01, "one-way-door": 0.99 } },
		level: { type: "choice", choice: "rigor", confidence: 0.98, probabilities: { lookup: 0.01, rigor: 0.98, loop: 0.01 } },
	};
	const live = () => new AbortController().signal;

	test("sends both questions in one request with the task as state", async () => {
		let sent: { url: string; body: unknown; auth: string | null } | undefined;
		const fetch: FetchLike = async (url, init) => {
			sent = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("Authorization") };
			return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answer }));
		};
		const outcome = await httpClassifier(async () => "test-key", fetch)(state, live());
		expect(sent).toEqual({ url: "https://api.typesafe.ai/v1/systemone", body: { model: "jev-latest", state: { task: "Migrate the ledger store to SQLite" }, questions: JSON.parse(JSON.stringify(QUESTIONS)) }, auth: "Bearer test-key" });
		expect(outcome).toMatchObject({ kind: "answered", answers: { door: { choice: "one-way-door" }, level: { choice: "rigor" }, model: "jev-1.13.0" } });
	});

	test("a slow key lookup is cut off by the same deadline as the request", async () => {
		let fetched = false;
		const slowKey = () => new Promise<string>((resolve) => setTimeout(() => resolve("k"), 500));
		const started = Date.now();
		const outcome = await httpClassifier(slowKey, async () => ((fetched = true), new Response("{}")))(state, AbortSignal.timeout(30));
		expect(outcome).toEqual({ kind: "failed", reason: "timeout" });
		expect(Date.now() - started).toBeLessThan(300);
		expect(fetched).toBe(false);
	});

	test("no key, an HTTP error, a malformed body, a timeout, or a cancel is a failure, never a throw", async () => {
		let calls = 0;
		const counted: FetchLike = async () => (calls++, new Response("{}"));
		expect(await httpClassifier(async () => undefined, counted)(state, live())).toEqual({ kind: "failed", reason: "classifier-unavailable" });
		expect(calls).toBe(0);
		expect(await httpClassifier(async () => "k", async () => new Response("{}", { status: 429 }))(state, live())).toEqual({ kind: "failed", reason: "error" });
		expect(await httpClassifier(async () => "k", async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { door: answer.door } })))(state, live())).toEqual({ kind: "failed", reason: "malformed" });
		expect(await httpClassifier(async () => "k", async () => new Response("not json"))(state, live())).toEqual({ kind: "failed", reason: "error" });
		const hanging: FetchLike = (_url, init) =>
			new Promise((_, reject) => {
				// Like fetch: an already-aborted signal rejects at once.
				if (init.signal?.aborted) reject(init.signal.reason);
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		expect(await httpClassifier(async () => "k", hanging)(state, AbortSignal.timeout(20))).toEqual({ kind: "failed", reason: "timeout" });
		const controller = new AbortController();
		const pending = httpClassifier(async () => "k", hanging)(state, controller.signal);
		controller.abort();
		expect(await pending).toEqual({ kind: "failed", reason: "cancelled" });
	});
});
