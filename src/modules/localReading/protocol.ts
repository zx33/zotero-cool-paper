import prompt from "./prompt.json";
import { ReadingError } from "./runtime";

export const MODEL = "kimi-k2.6";
export const PROTOCOL = "six-questions-v3-batch";
// Per-request allowance, including thinking. Length-ended answers continue;
// there is no per-answer character or spending limit.
export const MAX_OUTPUT = 32768;
export const PRICE_DATE = "2026-09-26";
export const BATCH_DISCOUNT = 0.6;
export const QUESTIONS = [
  "这篇论文试图解决什么问题？",
  "有哪些相关研究？",
  "论文如何解决这个问题？",
  "论文做了哪些实验？",
  "有什么可以进一步探索的点？",
  "总结一下论文的主要内容",
] as const;
export const QUESTION_IDS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
export type Question = (typeof QUESTION_IDS)[number];
export interface Answer {
  answer: string;
  // Retained for locally saved v2 reports. New Markdown answers cite the paper.
  sources: string[];
}
export type Answers = Partial<Record<Question, Answer>>;
export interface Source {
  id: string;
  text: string;
}
export interface Usage {
  input: number;
  output: number;
  cached?: number;
}
export interface Completion {
  content: string;
  reasoning?: string;
  finish?: string;
  done: boolean;
  usage?: Usage;
}
export interface Checks {
  errors: string[];
  warnings: string[];
}
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning_content?: string;
}
export interface BatchRequest {
  custom_id: string;
  method: "POST";
  url: "/v1/chat/completions";
  body: {
    model: typeof MODEL;
    messages: Message[];
    thinking: { type: "enabled"; keep?: "all" };
    max_tokens: number;
  };
}
export interface BatchResult {
  customID: string;
  completion?: Completion;
  error?: string;
}

export function decodeExtraction(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "content" in value
        ? value.content
        : null;
  if (typeof text !== "string" || !text.trim())
    throw new ReadingError("文件解析未返回可读正文，无法生成解读。");
  return text.trim();
}

export function makeSources(text: string): Source[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .filter((s) => s.trim())
    .map((text, i) => ({ id: `s${i + 1}`, text: text.trim() }));
}

export function messagesFor(
  text: string,
  question: Question,
  previous: Completion[] = [],
): Message[] {
  const messages: Message[] = [
    { role: "system", content: prompt.system },
    { role: "system", content: text },
    { role: "user", content: QUESTIONS[QUESTION_IDS.indexOf(question)] },
  ];
  for (const part of previous) {
    messages.push(
      {
        role: "assistant",
        content: part.content,
        ...(part.reasoning ? { reasoning_content: part.reasoning } : {}),
      },
      { role: "user", content: "请接着完成同一个问题，从上次中断处继续。" },
    );
  }
  return messages;
}

export function batchRequest(
  customID: string,
  text: string,
  question: Question,
  previous: Completion[] = [],
): BatchRequest {
  return {
    custom_id: customID,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: messagesFor(text, question, previous),
      thinking: {
        type: "enabled",
        ...(previous.length ? { keep: "all" as const } : {}),
      },
      max_tokens: MAX_OUTPUT,
    },
  };
}

export function parseBatchResults(text: string): BatchResult[] {
  const results: BatchResult[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new ReadingError("批次结果文件格式无效，已保留任务以便重新读取。");
    }
    if (typeof row?.custom_id !== "string" || seen.has(row.custom_id))
      throw new ReadingError("批次结果中的问题标识缺失或重复。");
    seen.add(row.custom_id);
    const body = row.response?.body;
    const choice = body?.choices?.find((c: { index?: number }) => !c.index);
    const result: BatchResult = { customID: row.custom_id };
    // Kimi's live Batch output also uses 0 for successful chat completions.
    const succeeded =
      row.response?.status_code === 200 ||
      (row.response?.status_code === 0 &&
        body?.object === "chat.completion" &&
        choice);
    if (row.error || body?.error || !succeeded) {
      const status = Number(row.response?.status_code);
      result.error =
        Number.isInteger(status) && status > 0
          ? `该题请求失败（HTTP ${status}）。`
          : "该题未完成，可单独重试。";
    } else if (
      typeof choice?.message?.content !== "string" &&
      !(
        choice?.finish_reason === "length" &&
        typeof choice.message?.reasoning_content === "string"
      )
    ) {
      result.error = "该题没有返回可读答案。";
    } else {
      result.completion = {
        content: choice.message.content ?? "",
        reasoning:
          typeof choice.message.reasoning_content === "string"
            ? choice.message.reasoning_content
            : undefined,
        finish: choice.finish_reason,
        done: choice.finish_reason === "stop",
        usage: usageFrom(body.usage),
      };
    }
    results.push(result);
  }
  return results;
}

export function usageFrom(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return;
  const u = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!valid(u.prompt_tokens) || !valid(u.completion_tokens)) return;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens;
  return {
    input: u.prompt_tokens,
    output: u.completion_tokens,
    cached: valid(cached) && cached <= u.prompt_tokens ? cached : undefined,
  };
}

export function totalUsage(results: BatchResult[]): Usage | undefined {
  const reported = results.flatMap((r) =>
    r.completion?.usage ? [r.completion.usage] : [],
  );
  if (!reported.length) return;
  return {
    input: reported.reduce((sum, u) => sum + u.input, 0),
    output: reported.reduce((sum, u) => sum + u.output, 0),
    cached: reported.every((u) => u.cached !== undefined)
      ? reported.reduce((sum, u) => sum + u.cached!, 0)
      : undefined,
  };
}

export function cost(usage: Usage, batch = false): number {
  const cached = usage.cached ?? 0;
  return (
    (((usage.input - cached) * 6.5 + cached * 1.1 + usage.output * 27) / 1e6) *
    (batch ? BATCH_DISCOUNT : 1)
  );
}
