import prompt from "./prompt.json";

export const MODEL = "kimi-k2.6";
export const PROTOCOL = "six-questions-v2.1-text";
export const MAX_OUTPUT = 4096;
export const PRICE_DATE = "2026-09-26";
export const QUESTIONS = [
  "这篇论文试图解决什么问题？",
  "有哪些相关研究？",
  "论文如何解决这个问题？",
  "论文做了哪些实验？",
  "有什么可以进一步探索的点？",
  "总结一下论文的主要内容",
] as const;
export const LIMITS = [250, 300, 600, 750, 200, 160];
export type Question = "q1" | "q2" | "q3" | "q4" | "q5" | "q6";
export interface Answer {
  answer: string;
  sources: string[];
}
export type Answers = Record<Question, Answer>;
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
  finish?: string;
  done: boolean;
  usage?: Usage;
}
export interface Checks {
  errors: string[];
  warnings: string[];
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
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("文件解析未返回可读正文，无法生成解读。");
  }
  return text.trim();
}

export function makeSources(text: string): Source[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .filter((s) => s.trim())
    .map((text, i) => ({ id: `s${i + 1}`, text: text.trim() }));
}

export function messagesFor(sources: Source[]) {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    { role: "system", content: prompt.system },
    {
      role: "user",
      content:
        "以下是文件接口返回的正文；sN 是段落编号，不是 PDF 页码。本次没有补充页图，不能声称已读取未解析的图片或扫描页。\n<paper>\n" +
        sources.map((s) => `[${s.id}]\n${escape(s.text)}`).join("\n\n") +
        "\n</paper>\n请完成六问，每题含 answer 和 sources。",
    },
  ];
}

export function responseFormat() {
  const properties = Object.fromEntries(
    LIMITS.map((limit, i) => [
      `q${i + 1}`,
      {
        type: "object",
        properties: {
          answer: { type: "string", minLength: 1, maxLength: limit },
          sources: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 16,
          },
        },
        required: ["answer", "sources"],
        additionalProperties: false,
      },
    ]),
  );
  return {
    type: "json_schema",
    json_schema: {
      name: "paper_six_questions_v2",
      strict: true,
      schema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
  };
}

export function validate(
  completion: Completion,
  sources: Source[],
): { answers?: Answers; checks: Checks } {
  const checks: Checks = { errors: [], warnings: [] };
  const fail = (message: string) => checks.errors.push(message);
  if (!completion.done || completion.finish !== "stop")
    fail("响应没有完整结束。");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(completion.content);
  } catch {
    fail("返回内容不是完整 JSON。");
    return { checks };
  }
  const keys = LIMITS.map((_, i) => `q${i + 1}`);
  if (
    !data ||
    Array.isArray(data) ||
    Object.keys(data).sort().join() !== keys.join()
  ) {
    fail("返回内容必须包含完整的六问。");
    return { checks };
  }
  const ids = new Set(sources.map((s) => s.id));
  for (const [i, key] of keys.entries()) {
    const answer = data[key] as Answer;
    if (
      !answer ||
      Object.keys(answer).sort().join() !== "answer,sources" ||
      typeof answer.answer !== "string" ||
      !answer.answer.trim() ||
      !Array.isArray(answer.sources)
    ) {
      fail(`${key} 的正文或来源格式无效。`);
      continue;
    }
    if ([...answer.answer].length > LIMITS[i])
      checks.warnings.push(`${key} 超过建议字数，保留全文供检查。`);
    if (/\[p\d+/.test(answer.answer)) fail(`${key} 引用了未提供的页码。`);
    const expanded = answer.sources.flatMap((ref) => {
      if (typeof ref !== "string" || ids.has(ref) || ref.length > 512)
        return [ref];
      const pattern = /(?<![a-zA-Z0-9_])s[1-9]\d*(?![a-zA-Z0-9_])/g;
      const matches = ref.match(pattern);
      if (
        matches?.every((id) => ids.has(id)) &&
        /^[\s,，;:'"[\]{}]*$/.test(ref.replace(pattern, ""))
      )
        return matches;
      return [ref];
    });
    if (
      expanded.length <= 16 &&
      JSON.stringify(expanded) !== JSON.stringify(answer.sources)
    ) {
      answer.sources = expanded;
      checks.warnings.push(`${key} 的来源列表标点已规范化，原始响应已保留。`);
    }
    if (
      !answer.sources.length ||
      answer.sources.length > 16 ||
      new Set(answer.sources).size !== answer.sources.length ||
      answer.sources.some((ref) => typeof ref !== "string" || !ids.has(ref))
    )
      fail(`${key} 的来源编号缺失、重复或不存在。`);
  }
  return {
    answers: checks.errors.length ? undefined : (data as Answers),
    checks,
  };
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

export function cost(usage: Usage): number {
  const cached = usage.cached ?? 0;
  return (
    ((usage.input - cached) * 6.5 + cached * 1.1 + usage.output * 27) / 1e6
  );
}

export function preflight(input: number, limit: number): number {
  if (
    !Number.isSafeInteger(input) ||
    input < 1 ||
    !Number.isFinite(limit) ||
    limit <= 0
  )
    throw new Error("无法取得有效的输入估算或费用上限。");
  if (input + 1024 + MAX_OUTPUT + 4096 > 256 * 1024)
    throw new Error("论文超过当前上下文预算，未发起生成。");
  const estimate = cost({ input: input + 1024, output: MAX_OUTPUT });
  if (estimate > limit)
    throw new Error(
      `预估费用上界 ¥${estimate.toFixed(3)} 超过设置的 ¥${limit.toFixed(2)}，未发起生成。`,
    );
  return estimate;
}
