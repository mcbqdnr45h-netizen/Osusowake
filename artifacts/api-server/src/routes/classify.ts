import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../middlewares/auth.js";
import { askClaude, hasClaudeKey, imageFromDataUrl } from "../lib/claude.js";

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

    if (!hasClaudeKey()) {
      res.json({ category: null });
      return;
    }
    // raw base64 だけ来た時は JPEG とみなす（従来どおり）
    const image = imageFromDataUrl(imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`);
    if (!image) {
      res.json({ category: null });
      return;
    }

    const validList = VALID_CATEGORIES.map(c => `"${c.value}" = ${c.label}`).join("\n");
    const raw = await askClaude({
      maxTokens: 2000,
      effort: "low",
      messages: [
        {
          role: "user",
          content: [
            image,
            { type: "text", text: `この食べ物の画像を見て、次の3つのカテゴリから最も合うものを1つ選んでください。\n\n${validList}` },
          ],
        },
      ],
      jsonSchema: {
        type: "object",
        properties: { category: { type: "string", enum: VALID_CATEGORIES.map(c => c.value) } },
        required: ["category"],
        additionalProperties: false,
      },
    });
    const picked = (JSON.parse(raw) as { category?: unknown }).category;
    const matched = VALID_CATEGORIES.find(c => c.value === picked);

    console.log(`[suggest-category] raw="${raw}" → category=${matched?.value ?? null}`);
    res.json({ category: matched?.value ?? null });
  } catch (err: any) {
    console.error("[suggest-category] error:", err?.message ?? err);
    res.status(500).json({ error: "internal_error", message: "Failed to classify image" });
  }
});

export default router;
