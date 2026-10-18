-- Supple check-in database (Postgres).
-- The API creates these automatically on first request, so running this file
-- by hand is optional. It is kept here as the reference schema.

-- One row per check-in attempt.
CREATE TABLE IF NOT EXISTS assessments (
  id             uuid PRIMARY KEY,                  -- random id made in the browser per check-in
  anon_id        uuid NOT NULL,                     -- random id per browser (no name/email)
  lang           text NOT NULL DEFAULT 'en',        -- en | zh | pt
  mood_start     text,                              -- cautious | stiff | curious | ready
  device         text,                              -- mobile | tablet | desktop
  country        text,                              -- 2-letter code from Vercel's edge, if available
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,                       -- set when all 7 movements are answered
  region_scores  jsonb                              -- {"neck":2,"hips":0.5,...} 0 = limited … 2 = full
);
CREATE INDEX IF NOT EXISTS assessments_anon_idx    ON assessments (anon_id);
CREATE INDEX IF NOT EXISTS assessments_started_idx ON assessments (started_at);

-- One row per movement test answered (latest answer wins if they change it).
CREATE TABLE IF NOT EXISTS answers (
  assessment_id  uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  test_id        text NOT NULL,                     -- neck_rotation, shoulder_reach, …
  regions        text[] NOT NULL,                   -- body regions the test measures
  score          smallint NOT NULL CHECK (score BETWEEN 0 AND 2),  -- 0 limited, 1 partial, 2 full
  answered_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, test_id)
);
CREATE INDEX IF NOT EXISTS answers_answered_idx ON answers (answered_at);

-- "How do you feel now?" answers at the end of a Train-with-me session.
CREATE TABLE IF NOT EXISTS session_feedback (
  id             bigserial PRIMARY KEY,
  anon_id        uuid NOT NULL,
  assessment_id  uuid REFERENCES assessments(id) ON DELETE SET NULL,
  session_label  text,
  feel           text NOT NULL,                     -- looser | same | tired | hurt
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per "Train with me" session.
CREATE TABLE IF NOT EXISTS training_sessions (
  id              uuid PRIMARY KEY,                 -- random id made in the browser per session
  anon_id         uuid NOT NULL,
  assessment_id   uuid REFERENCES assessments(id) ON DELETE SET NULL,  -- latest check-in, if any
  source          text NOT NULL,                    -- today | region | library
  session_label   text,                             -- e.g. "Fri · Mobility · 12 min"
  lang            text NOT NULL DEFAULT 'en',
  device          text,
  exercises_total smallint,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  completed       boolean NOT NULL DEFAULT false,   -- reached the "Session complete" screen
  last_position   smallint                          -- exercise index they were on when it ended
);
CREATE INDEX IF NOT EXISTS training_sessions_started_idx ON training_sessions (started_at);

-- One row each time someone is on an exercise screen (going back and forth adds rows).
CREATE TABLE IF NOT EXISTS training_exercises (
  id               bigserial PRIMARY KEY,
  training_id      uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  exercise_id      text NOT NULL,                   -- chin_tucks, glute_bridge, …
  region           text NOT NULL,
  position         smallint NOT NULL,               -- 0-based place in the session
  started          boolean NOT NULL,                -- pressed Start on the timer
  active_seconds   int NOT NULL,                    -- seconds the timer actually ran (pauses excluded)
  timer_completed  boolean NOT NULL,                -- timer reached 0
  view_seconds     int NOT NULL,                    -- time on the screen
  action           text NOT NULL,                   -- next | prev | finish | close | library
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_exercises_training_idx ON training_exercises (training_id);
CREATE INDEX IF NOT EXISTS training_exercises_exercise_idx ON training_exercises (exercise_id);

-- Links the end-of-session feeling to its session.
ALTER TABLE session_feedback ADD COLUMN IF NOT EXISTS training_id uuid REFERENCES training_sessions(id) ON DELETE SET NULL;

-- One row per (answer × region), handy for "which body part has the most problems".
CREATE OR REPLACE VIEW region_answers AS
SELECT a.assessment_id, r.region, a.test_id, a.score, s.mood_start, s.lang, s.country, a.answered_at
FROM answers a
JOIN assessments s ON s.id = a.assessment_id
CROSS JOIN LATERAL unnest(a.regions) AS r(region);
