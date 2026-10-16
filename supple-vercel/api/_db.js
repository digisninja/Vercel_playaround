// Shared database helper. Files starting with "_" are not exposed as API routes on Vercel.
import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// One small connection per function instance. prepare:false keeps it compatible
// with pooled connection strings (Neon pooler, Supabase transaction pooler).
export const sql = url
  ? postgres(url, { ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : "require", max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false })
  : null;

// Keep in sync with db/schema.sql
const SCHEMA = `
CREATE TABLE IF NOT EXISTS assessments (
  id uuid PRIMARY KEY, anon_id uuid NOT NULL, lang text NOT NULL DEFAULT 'en',
  mood_start text, device text, country text,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, region_scores jsonb);
CREATE INDEX IF NOT EXISTS assessments_anon_idx ON assessments (anon_id);
CREATE INDEX IF NOT EXISTS assessments_started_idx ON assessments (started_at);
CREATE TABLE IF NOT EXISTS answers (
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  test_id text NOT NULL, regions text[] NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 2),
  answered_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (assessment_id, test_id));
CREATE INDEX IF NOT EXISTS answers_answered_idx ON answers (answered_at);
CREATE TABLE IF NOT EXISTS session_feedback (
  id bigserial PRIMARY KEY, anon_id uuid NOT NULL,
  assessment_id uuid REFERENCES assessments(id) ON DELETE SET NULL,
  session_label text, feel text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE VIEW region_answers AS
SELECT a.assessment_id, r.region, a.test_id, a.score, s.mood_start, s.lang, s.country, a.answered_at
FROM answers a JOIN assessments s ON s.id = a.assessment_id
CROSS JOIN LATERAL unnest(a.regions) AS r(region);
`;

let ready = null;
export function ensureSchema() {
  if (!ready) ready = sql.unsafe(SCHEMA).catch((e) => { ready = null; throw e; });
  return ready;
}

// ---- Allowed values (anything else is rejected) ----
export const REGIONS = ["neck", "shoulders", "thoracic", "lumbar", "hips", "knees", "ankles"];
export const TESTS = {
  neck_rotation: ["neck"],
  shoulder_reach: ["shoulders"],
  seated_twist: ["thoracic"],
  toe_reach: ["lumbar", "hips"],
  chair_stand_30s: ["hips", "knees"],
  single_leg_stand: ["ankles"],
  knee_to_wall: ["ankles", "knees"],
};
export const MOODS = ["cautious", "stiff", "curious", "ready"];
export const FEELS = ["looser", "same", "tired", "hurt"];
export const LANGS = ["en", "zh", "pt"];
export const isUuid = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

// Constant-time token check for the admin endpoints.
export function isAdmin(req) {
  const want = process.env.ADMIN_TOKEN || "";
  const auth = String(req.headers.authorization || "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!want || want.length < 12 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
