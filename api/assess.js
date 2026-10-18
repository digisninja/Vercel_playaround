// POST /api/assess — receives anonymous check-in events from the website.
// Event types: start | answer | complete | feel | train_start | train_exercise | train_end
import { sql, ensureSchema, REGIONS, TESTS, MOODS, FEELS, LANGS, EXERCISES, TRAIN_SOURCES, TRAIN_ACTIONS, isUuid } from "./_db.js";

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
      const tid = isUuid(b.training_id) ? b.training_id : null;
      await sql`
        INSERT INTO session_feedback (anon_id, assessment_id, session_label, feel, training_id)
        VALUES (${anon_id}, (SELECT id FROM assessments WHERE id = ${aid} AND anon_id = ${anon_id}), ${label}, ${b.feel},
                (SELECT id FROM training_sessions WHERE id = ${tid} AND anon_id = ${anon_id}))`;
      return res.status(204).end();
    }

    // ---- Train with me ----
    const tid = b.training_id;
    const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

    if (type === "train_start") {
      if (!isUuid(tid)) return res.status(400).json({ error: "training_id must be a UUID." });
      if (!TRAIN_SOURCES.includes(b.source)) return res.status(400).json({ error: "Unknown source." });
      const aid = isUuid(assessment_id) ? assessment_id : null;
      const label = typeof b.session === "string" ? b.session.slice(0, 120) : null;
      await sql`
        INSERT INTO training_sessions (id, anon_id, assessment_id, source, session_label, lang, device, exercises_total)
        VALUES (${tid}, ${anon_id}, (SELECT id FROM assessments WHERE id = ${aid} AND anon_id = ${anon_id}),
                ${b.source}, ${label}, ${lang}, ${deviceFrom(req.headers["user-agent"])}, ${int(b.exercises, 20)})
        ON CONFLICT (id) DO NOTHING`;
      return res.status(204).end();
    }

    if (type === "train_exercise") {
      if (!isUuid(tid)) return res.status(400).json({ error: "training_id must be a UUID." });
      const region = EXERCISES[b.exercise_id];
      if (!region) return res.status(400).json({ error: "Unknown exercise_id." });
      const action = TRAIN_ACTIONS.includes(b.action) ? b.action : "next";
      await sql`
        INSERT INTO training_exercises (training_id, exercise_id, region, position, started, active_seconds, timer_completed, view_seconds, action)
        SELECT ${tid}, ${b.exercise_id}, ${region}, ${int(b.position, 20)}, ${b.started === true},
               ${int(b.active_seconds, 3600)}, ${b.timer_completed === true}, ${int(b.view_seconds, 7200)}, ${action}
        WHERE EXISTS (SELECT 1 FROM training_sessions WHERE id = ${tid} AND anon_id = ${anon_id})`;
      return res.status(204).end();
    }

    if (type === "train_end") {
      if (!isUuid(tid)) return res.status(400).json({ error: "training_id must be a UUID." });
      await sql`
        UPDATE training_sessions SET ended_at = now(), completed = ${b.completed === true}, last_position = ${int(b.last_position, 20)}
        WHERE id = ${tid} AND anon_id = ${anon_id} AND ended_at IS NULL`;
      return res.status(204).end();
    }

    return res.status(400).json({ error: "Unknown event type." });
  } catch (err) {
    console.error("assess error", err);
    return res.status(500).json({ error: "Could not save the event." });
  }
}
