// GET /api/export?days=90 — raw check-in answers as CSV (one row per test answered).
// GET /api/export?days=90&table=training — one row per exercise visit in Train with me.
// Requires header: Authorization: Bearer <ADMIN_TOKEN>
import { sql, ensureSchema, isAdmin } from "./_db.js";

const cell = (v) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  if (!isAdmin(req)) return res.status(401).json({ error: "Wrong or missing admin token." });
  if (!sql) return res.status(503).json({ error: "DATABASE_URL is not set." });

  const days = Math.min(3650, Math.max(1, parseInt(req.query.days, 10) || 90));
  try {
    await ensureSchema();
    if (req.query.table === "training") {
      const trows = await sql`
        SELECT ts.id AS training_id, ts.anon_id, ts.source, ts.session_label, ts.lang, ts.device, ts.started_at, ts.ended_at,
               ts.completed, te.position, te.exercise_id, te.region, te.started, te.active_seconds, te.timer_completed,
               te.view_seconds, te.action, te.created_at
        FROM training_sessions ts LEFT JOIN training_exercises te ON te.training_id = ts.id
        WHERE ts.started_at > now() - ${days} * interval '1 day'
        ORDER BY ts.started_at, te.created_at`;
      const tcols = ["training_id", "anon_id", "source", "session_label", "lang", "device", "started_at", "ended_at", "completed",
                     "position", "exercise_id", "region", "started", "active_seconds", "timer_completed", "view_seconds", "action", "created_at"];
      const tcsv = [tcols.join(","), ...trows.map((r) => tcols.map((c) => cell(r[c])).join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="supple-training-${days}d.csv"`);
      return res.status(200).send(tcsv);
    }
    const rows = await sql`
      SELECT s.id AS assessment_id, s.anon_id, s.lang, s.mood_start, s.device, s.country,
             s.started_at, s.completed_at, a.test_id, a.regions, a.score, a.answered_at
      FROM assessments s
      LEFT JOIN answers a ON a.assessment_id = s.id
      WHERE s.started_at > now() - ${days} * interval '1 day'
      ORDER BY s.started_at, a.test_id`;
    const cols = ["assessment_id", "anon_id", "lang", "mood_start", "device", "country",
                  "started_at", "completed_at", "test_id", "regions", "score", "answered_at"];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="supple-answers-${days}d.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error("export error", err);
    return res.status(500).json({ error: "Could not export." });
  }
}
