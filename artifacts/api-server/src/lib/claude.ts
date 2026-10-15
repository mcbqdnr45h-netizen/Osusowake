import Anthropic from "@anthropic-ai/sdk";

// AI は全部 Claude に統一（2026-10-16 に OpenAI から移行）。
//   鍵は Fly secret の ANTHROPIC_API_KEY。 Maxプランに付く月$100のAPIクレジットで払われる。
//   未設定なら呼び出し側が AI 無しの動き（テンプレ/null）に倒れる。
export const CLAUDE_MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;

export function hasClaudeKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClaude(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

// data URL（data:image/png;base64,....）を Claude の画像ブロックにする。 対応外の形式は null。
export function imageFromDataUrl(dataUrl: string): Anthropic.Beta.BetaImageBlockParam | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const mediaType = IMAGE_MEDIA_TYPES.find((t): t is ImageMediaType => t === m[1]);
  if (!mediaType) return null;
  return { type: "image", source: { type: "base64", media_type: mediaType, data: m[2] } };
}

/**
 * Claude に1回聞いて、返ってきた文章を返す。
 *   jsonSchema を渡すと、 その形の JSON 文字列だけが返る（structured outputs）。
 *   安全判定で断られた時は fallbacks:"default" で別モデルが代わりに答える。 それでも断られたら throw。
 */
export async function askClaude(opts: {
  system?: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens: number;
  effort: "low" | "medium" | "high";
  jsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const res = await getClaude().beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: opts.maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    output_config: {
      effort: opts.effort,
      ...(opts.jsonSchema ? { format: { type: "json_schema" as const, schema: opts.jsonSchema } } : {}),
    },
  });
  if (res.stop_reason === "refusal") throw new Error("claude_refusal");
  if (res.stop_reason === "max_tokens") throw new Error("claude_max_tokens");
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
