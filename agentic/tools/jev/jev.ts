// The task-class hint at task start: Jev's one-way-door question, asked alone, gives a hint when Jev
// says one-way door or is unsure, never otherwise. The question, the door rule, and the hint text
// come from route.ts's policy. Only tasks in public repositories are classified, and any failure
// gives no hint.

import { askJev, apiKey, isProbability, isPublic, isTask, originSlug, sendable, type FetchLike, type Unavailable } from "./egress.ts";
import { doorNote, doorRule, POLICY, QUESTIONS, TASK_CRITERIA, type DoorClass } from "./route.ts";

export type Choice = { kind: "ok"; choice: DoorClass; confidence: number } | Unavailable;

export async function taskClass(task: string, options: Parameters<typeof askJev>[2]): Promise<Choice> {
	const answer = await askJev(QUESTIONS.door, task, options);
	if (answer.kind === "unavailable") return answer as Unavailable;
	const valid = answer.type === "choice" && typeof answer.choice === "string" && answer.choice in TASK_CRITERIA && isProbability(answer.confidence);
	return valid ? { kind: "ok", choice: answer.choice as DoorClass, confidence: answer.confidence as number } : { kind: "unavailable", detail: "malformed choice answer" };
}

/** The hint for a task, or undefined when there is nothing to say (including when Jev failed). */
export function taskHint(result: Choice): string | undefined {
	if (result.kind === "unavailable") return undefined;
	const door = doorRule(result, POLICY);
	return door ? doorNote(door) : undefined;
}

/** The task-class hint for a prompt typed in cwd: only for tasks in public GitHub repositories. */
export async function taskHintFor(prompt: string, cwd: string, env: NodeJS.ProcessEnv = process.env, fetch?: FetchLike): Promise<string | undefined> {
	const text = sendable(prompt);
	if (!text || !isTask(prompt)) return undefined;
	const deadline = Date.now() + POLICY.deadlineMs;
	const left = () => deadline - Date.now();
	const slug = await originSlug(cwd, left());
	if (!slug || !(await isPublic(slug, { env, timeoutMs: left() }))) return undefined;
	const key = await apiKey(env, left());
	if (left() <= 0) return undefined;
	return taskHint(await taskClass(text, { apiKey: key, timeoutMs: left(), fetch }));
}
