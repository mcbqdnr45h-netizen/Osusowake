import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../middlewares/auth.js";

const router: IRouter = Router();

// 1回ごとに有料のAIを呼ぶので、 ログイン必須＋1人1分10回まで。
//   以前はログイン無しで誰でも呼べた（IPあたり1分600回の全体制限だけ）。
const classifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.authUser?.id ?? "anonymous",
  message: { error: "rate_limited", message: "AIの自動判定は少し時間をおいてからお試しください。" },
});

const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;

// 本番Flyは OPENAI_API_KEY、 ローカル開発は AI_INTEGRATIONS_* を使う。
const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
  apiKey:  process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy",
});

const VALID_CATEGORIES = [
  { value: "meals",         label: "料理・お惣菜（飲食店・居酒屋・弁当・惣菜・麺類・肉・魚など）" },
  { value: "bakery_sweets", label: "パン・スイーツ（ベーカリー・カフェ・菓子・ドリンクなど）" },
  { value: "ingredients",   label: "食材・その他（生鮮食品・野菜・果物・加工品・飲料など）" },
];

/**
 * POST /api/suggest-category
 * body: { imageBase64: string }   (data URL or raw base64)
 * res:  { category: string | null }
 */
router.post("/suggest-category", requireAuth, classifyLimiter, async (req, res) => {
  try {
    const { imageBase64 } = req.body as { imageBase64?: string };
    if (!imageBase64) {
      res.status(400).json({ error: "bad_request", message: "imageBase64 is required" });
      return;
    }
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      res.status(413).json({ error: "too_large", message: "画像が大きすぎます" });
      return;
    }

    // data URL → raw base64 に変換
    const base64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const mimeMatch = imageBase64.match(/^data:([^;]+);/);
    const mimeType  = (mimeMatch?.[1] ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    const validList = VALID_CATEGORIES.map(c => `"${c.value}" = ${c.label}`).join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 20,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}`, detail: "low" },
            },
            {
              type: "text",
              text: `この食べ物の画像を見て、以下の3つのカテゴリから最も適切なものを1つだけ英語のキーで答えてください。余計な説明は不要です。\n\n${validList}\n\n答え（キーのみ）:`,
            },
          ],
        },
      ],
    });

    const raw = (response.choices[0]?.message?.content ?? "").trim().toLowerCase().replace(/[^a-z_]/g, "");
    const matched = VALID_CATEGORIES.find(c => raw.includes(c.value));

    console.log(`[suggest-category] raw="${raw}" → category=${matched?.value ?? null}`);
    res.json({ category: matched?.value ?? null });
  } catch (err: any) {
    console.error("[suggest-category] error:", err?.message ?? err);
    res.status(500).json({ error: "internal_error", message: "Failed to classify image" });
  }
});

export default router;
