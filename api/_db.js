// Shared database helper. Files starting with "_" are not exposed as API routes on Vercel.
import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// One small connection per function instance. prepare:false keeps it compatible
// with pooled connection strings (Neon pooler, Supabase transaction pooler).
export const sql = url
  ? postgres(url, { ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : "require", max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false, onnotice: () => {} })
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
CREATE TABLE IF NOT EXISTS training_sessions (
  id uuid PRIMARY KEY, anon_id uuid NOT NULL,
  assessment_id uuid REFERENCES assessments(id) ON DELETE SET NULL,
  source text NOT NULL, session_label text, lang text NOT NULL DEFAULT 'en', device text,
  exercises_total smallint, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  completed boolean NOT NULL DEFAULT false, last_position smallint);
CREATE INDEX IF NOT EXISTS training_sessions_started_idx ON training_sessions (started_at);
CREATE TABLE IF NOT EXISTS training_exercises (
  id bigserial PRIMARY KEY,
  training_id uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  exercise_id text NOT NULL, region text NOT NULL, position smallint NOT NULL,
  started boolean NOT NULL, active_seconds int NOT NULL, timer_completed boolean NOT NULL,
  view_seconds int NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS training_exercises_training_idx ON training_exercises (training_id);
CREATE INDEX IF NOT EXISTS training_exercises_exercise_idx ON training_exercises (exercise_id);
ALTER TABLE session_feedback ADD COLUMN IF NOT EXISTS training_id uuid REFERENCES training_sessions(id) ON DELETE SET NULL;
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
// Trainer exercises (id → body region). ids are the English exercise names in snake_case.
export const EXERCISES = {"chin_tucks":"neck","slow_neck_turns":"neck","upper_trap_stretch":"neck","wall_slides":"shoulders","band_pull_aparts":"shoulders","doorway_chest_stretch":"shoulders","open_book":"thoracic","cat_cow":"thoracic","chair_back_extension":"thoracic","dead_bug":"lumbar","bird_dog":"lumbar","90_90_breathing":"lumbar","90_90_switches":"hips","glute_bridge":"hips","half_kneeling_hip_flexor_stretch":"hips","sit_to_stand":"knees","heel_slides":"knees","step_ups":"knees","knee_to_wall_rocks":"ankles","calf_raises":"ankles","tandem_stance":"ankles"};
export const TRAIN_SOURCES = ["today", "region", "library"];
export const TRAIN_ACTIONS = ["next", "prev", "finish", "close", "library"];
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
