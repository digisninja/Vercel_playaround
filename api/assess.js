// POST /api/assess — receives anonymous check-in events from the website.
// Event types: start | answer | complete | feel
import { sql, ensureSchema, REGIONS, TESTS, MOODS, FEELS, LANGS, isUuid } from "./_db.js";

function deviceFrom(ua = "") {
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
  return "desktop";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  // Optional: only accept events from your own site (set ALLOWED_ORIGIN, e.g. https://supple.vercel.app)
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && !allowed.split(",").map((s) => s.trim()).includes(req.headers.origin)) {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  if (!sql) return res.status(503).json({ error: "DATABASE_URL is not set." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return res.status(400).json({ error: "Send a JSON body." });

  const { type, anon_id, assessment_id } = b;
  const lang = LANGS.includes(b.lang) ? b.lang : "en";
  if (!isUuid(anon_id)) return res.status(400).json({ error: "anon_id must be a UUID." });

  try {
    await ensureSchema();

    if (type === "start") {
      if (!isUuid(assessment_id)) return res.status(400).json({ error: "assessment_id must be a UUID." });
      const mood = MOODS.includes(b.mood) ? b.mood : null;
      const device = deviceFrom(req.headers["user-agent"]);
      const country = String(req.headers["x-vercel-ip-country"] || "").slice(0, 2) || null;
      await sql`
        INSERT INTO assessments (id, anon_id, lang, mood_start, device, country)
        VALUES (${assessment_id}, ${anon_id}, ${lang}, ${mood}, ${device}, ${country})
        ON CONFLICT (id) DO UPDATE SET mood_start = EXCLUDED.mood_start, lang = EXCLUDED.lang
        WHERE assessments.anon_id = EXCLUDED.anon_id`;
      return res.status(204).end();
    }

    if (type === "answer") {
      if (!isUuid(assessment_id)) return res.status(400).json({ error: "assessment_id must be a UUID." });
      const regions = TESTS[b.test_id];
      const score = Number(b.score);
      if (!regions) return res.status(400).json({ error: "Unknown test_id." });
      if (![0, 1, 2].includes(score)) return res.status(400).json({ error: "score must be 0, 1 or 2." });
      // Make sure the parent row exists (e.g. if the start event was lost).
      await sql`
        INSERT INTO assessments (id, anon_id, lang, device)
        VALUES (${assessment_id}, ${anon_id}, ${lang}, ${deviceFrom(req.headers["user-agent"])})
        ON CONFLICT (id) DO NOTHING`;
      // Only the browser that started the check-in may write to it.
      await sql`
        INSERT INTO answers (assessment_id, test_id, regions, score)
        SELECT ${assessment_id}, ${b.test_id}, ${"{" + regions.join(",") + "}"}::text[], ${score}
        WHERE EXISTS (SELECT 1 FROM assessments WHERE id = ${assessment_id} AND anon_id = ${anon_id})
        ON CONFLICT (assessment_id, test_id) DO UPDATE SET score = EXCLUDED.score, answered_at = now()`;
      return res.status(204).end();
    }

    if (type === "complete") {
      if (!isUuid(assessment_id)) return res.status(400).json({ error: "assessment_id must be a UUID." });
      const raw = b.region_scores && typeof b.region_scores === "object" ? b.region_scores : {};
      const clean = {};
      for (const r of REGIONS) {
        const v = raw[r];
        clean[r] = typeof v === "number" && v >= 0 && v <= 2 ? Math.round(v * 100) / 100 : null;
      }
      await sql`
        UPDATE assessments SET completed_at = now(), region_scores = ${sql.json(clean)}
        WHERE id = ${assessment_id} AND anon_id = ${anon_id}`;
      return res.status(204).end();
    }

    if (type === "feel") {
      if (!FEELS.includes(b.feel)) return res.status(400).json({ error: "Unknown feel value." });
      const aid = isUuid(assessment_id) ? assessment_id : null;
      const label = typeof b.session === "string" ? b.session.slice(0, 120) : null;
      await sql`
        INSERT INTO session_feedback (anon_id, assessment_id, session_label, feel)
        VALUES (${anon_id}, (SELECT id FROM assessments WHERE id = ${aid} AND anon_id = ${anon_id}), ${label}, ${b.feel})`;
      return res.status(204).end();
    }

    return res.status(400).json({ error: "Unknown event type." });
  } catch (err) {
    console.error("assess error", err);
    return res.status(500).json({ error: "Could not save the event." });
  }
}
