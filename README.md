# Supple Body Atlas — Vercel project

This is the static website plus a small API that saves anonymous check-in answers to Postgres, and a private dashboard to read them.

```
public/
  index.html      the website (with your Vercel Analytics + GA tags at the bottom)
  admin.html      private dashboard → https://your-site/admin
api/
  _db.js          database connection, auto-creates tables, allowed values
  assess.js       POST /api/assess   ← the website sends events here
  stats.js        GET  /api/stats    ← dashboard data (needs ADMIN_TOKEN)
  export.js       GET  /api/export   ← CSV download of every answer (needs ADMIN_TOKEN)
db/schema.sql     reference schema (tables are created automatically on first use)
vercel.json       security headers, no-index for /admin and /api
.env.example      environment variables you need
```

## Deploy (about 10 minutes)

1. **Put the folder on GitHub.** Create a new repository and push this folder.
2. **Import it in Vercel.** Vercel → Add New → Project → pick the repo. Framework preset: **Other**. Leave the build command empty; the output folder is detected as `public`.
3. **Add a database.** In the project: **Storage → Create / Connect → Neon (Postgres)** (or Supabase). Connect it to the project for Production and Preview. Vercel adds `DATABASE_URL` for you.
4. **Add the admin password.** Project → Settings → Environment Variables → add `ADMIN_TOKEN` with a long random value (e.g. run `openssl rand -hex 24`). At least 12 characters.
5. *(Optional)* add `ALLOWED_ORIGIN=https://your-domain.com` so only your site can post events.
6. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables are picked up.
7. **Turn on Vercel Web Analytics** in the project's Analytics tab (your `/_vercel/insights/script.js` tag needs this).
8. Open the site, do a check-in, then visit `/admin`, paste the token and press **Load**.

The tables are created automatically on the first event. To create them by hand instead, paste `db/schema.sql` into the Neon/Supabase SQL editor.

## What gets saved

Nothing is sent if the visitor unticks **"Save my answers anonymously"** on the first check-in step.

| Event | When | Saved |
|---|---|---|
| `start` | "Start the movements" | random check-in id, random browser id, language, starting mood, device type, country (from Vercel) |
| `answer` | each of the 7 tests | test id, body regions, score 0 limited / 1 partial / 2 full (changing an answer overwrites it) |
| `complete` | results screen | per-region scores, completion time |
| `feel` | end of a Train-with-me session | looser / same / tired / hurt and the session name |

No names, emails, IP addresses or free text are stored.

The same moments are sent to Google Analytics as custom events: `assess_start`, `assess_answer` (test_id, region, score, score_label), `assess_complete` (mood, language, focus_region) and `train_feedback` (feel). To use those parameters in GA reports, register them in GA → Admin → Custom definitions as event-scoped dimensions.

## Useful SQL

```sql
-- Which body region has the most "limited" answers
SELECT region, round(100.0 * avg((score = 0)::int), 1) AS pct_limited, count(*)
FROM region_answers GROUP BY region ORDER BY pct_limited DESC;

-- Problem regions by how people felt before starting
SELECT mood_start, region, round(avg(score), 2) AS avg_score, count(*)
FROM region_answers GROUP BY 1, 2 ORDER BY 1, 3;

-- Completion rate by language
SELECT lang, count(*) started, count(completed_at) completed FROM assessments GROUP BY lang;
```

## Run locally (optional)

```
npm i -g vercel
vercel link            # connect to the Vercel project
vercel env pull .env   # copies DATABASE_URL and ADMIN_TOKEN
vercel dev             # http://localhost:3000
```

## Privacy note

Answers relate to health, so keep the anonymous design, keep the consent line, and mention the data use in a privacy page before promoting the site. The site is meant for Ontario/Canada, so PIPEDA applies; get a qualified review before collecting at scale.
