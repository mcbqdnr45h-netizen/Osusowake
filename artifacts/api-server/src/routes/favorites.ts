import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { favoritesTable, storesTable } from "@workspace/db/schema";
import { eq, and, inArray, desc } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase";

const router: IRouter = Router();

async function getUserId(req: any): Promise<string | null> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

router.get("/favorites", async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauthorized" }); return; }

  try {
    // ★ 2026-08-12: ORDER BY が無く、お気に入りの並びがDB任せ＝開くたびに変わり得た。
    //   お気に入り画面はこの順をそのまま表示するため、ユーザーには「並びが勝手に入れ替わる」
    //   ように見える。登録が新しい順に固定する（同時刻は id で最終決着＝毎回同じ並び）。
    const rows = await db
      .select({ storeId: favoritesTable.storeId })
      .from(favoritesTable)
      .where(eq(favoritesTable.userId, userId))
      .orderBy(desc(favoritesTable.createdAt), desc(favoritesTable.id));

    res.json({ storeIds: rows.map(r => r.storeId) });
  } catch (err) {
    console.error("[favorites] GET error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/favorites/:storeId", async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauthorized" }); return; }

  const storeId = parseInt(req.params.storeId, 10);
  if (isNaN(storeId)) { res.status(400).json({ error: "invalid_store_id" }); return; }

  try {
    await db
      .insert(favoritesTable)
      .values({ userId, storeId })
      .onConflictDoNothing();

    res.json({ ok: true });
  } catch (err) {
    console.error("[favorites] POST error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/favorites/:storeId", async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauthorized" }); return; }

  const storeId = parseInt(req.params.storeId, 10);
  if (isNaN(storeId)) { res.status(400).json({ error: "invalid_store_id" }); return; }

  try {
    await db
      .delete(favoritesTable)
      .where(and(eq(favoritesTable.userId, userId), eq(favoritesTable.storeId, storeId)));

    res.json({ ok: true });
  } catch (err) {
    console.error("[favorites] DELETE error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
export { getUserId as getFavoritesUserId };
