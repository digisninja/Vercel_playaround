// GET /api/stats?days=90 — aggregated results for the private dashboard (admin.html).
// Requires header: Authorization: Bearer <ADMIN_TOKEN>
import { sql, ensureSchema, isAdmin } from "./_db.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  if (!isAdmin(req)) return res.status(401).json({ error: "Wrong or missing admin token." });
  if (!sql) return res.status(503).json({ error: "DATABASE_URL is not set." });

  const days = Math.min(3650, Math.max(1, parseInt(req.query.days, 10) || 90));
  const since = sql`now() - ${days} * interval '1 day'`;

  try {
    await ensureSchema();
    const [totals, byRegion, byTest, byMood, moodRegion, focus, byLang, byDevice, feedback, daily] = await Promise.all([
      sql`SELECT count(*)::int AS started, count(completed_at)::int AS completed,
                 count(DISTINCT anon_id)::int AS people
          FROM assessments WHERE started_at > ${since}`,
      sql`SELECT region, count(*)::int AS n, round(avg(score)::numeric, 2)::float AS avg,
                 sum((score = 0)::int)::int AS limited, sum((score = 1)::int)::int AS partial,
                 sum((score = 2)::int)::int AS full
          FROM region_answers WHERE answered_at > ${since} GROUP BY region`,
      sql`SELECT test_id, score, count(*)::int AS n
          FROM answers WHERE answered_at > ${since} GROUP BY test_id, score`,
      sql`SELECT coalesce(mood_start, 'unknown') AS mood, count(*)::int AS started,
                 count(completed_at)::int AS completed
          FROM assessments WHERE started_at > ${since} GROUP BY 1`,
      sql`SELECT coalesce(mood_start, 'unknown') AS mood, region,
                 round(avg(score)::numeric, 2)::float AS avg, count(*)::int AS n
          FROM region_answers WHERE answered_at > ${since} GROUP BY 1, 2`,
      // The weakest region of each completed check-in = what people most need help with.
      sql`SELECT region, count(*)::int AS n FROM (
            SELECT DISTINCT ON (a.id) a.id, e.key AS region
            FROM assessments a, jsonb_each(a.region_scores) e
            WHERE a.completed_at IS NOT NULL AND a.started_at > ${since} AND jsonb_typeof(e.value) = 'number'
            ORDER BY a.id, (e.value #>> '{}')::float ASC
          ) t GROUP BY region ORDER BY n DESC`,
      sql`SELECT lang, count(*)::int AS n FROM assessments WHERE started_at > ${since} GROUP BY lang`,
      sql`SELECT coalesce(device, 'unknown') AS device, count(*)::int AS n FROM assessments WHERE started_at > ${since} GROUP BY 1`,
      sql`SELECT feel, count(*)::int AS n FROM session_feedback WHERE created_at > ${since} GROUP BY feel`,
      sql`SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
                 count(*)::int AS started, count(completed_at)::int AS completed
          FROM assessments WHERE started_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
    ]);
    return res.status(200).json({
      days, totals: totals[0], byRegion, byTest, byMood, moodRegion, focus, byLang, byDevice, feedback, daily,
    });
  } catch (err) {
    console.error("stats error", err);
    return res.status(500).json({ error: "Could not load stats." });
  }
}
