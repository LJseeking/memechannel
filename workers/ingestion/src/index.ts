interface Env {
  DB: D1Database;
  SOCIALDATA_API_KEY: string;
  APIFY_API_TOKEN?: string;
  INGESTION_TRIGGER_SECRET?: string;
}

type SocialDataTweet = {
  id?: string | number;
  id_str?: string;
  text?: string;
  full_text?: string;
  tweet_created_at?: string;
  created_at?: string;
  user?: {
    screen_name?: string;
    name?: string;
  };
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
};

type RawPost = {
  id: string;
  scanId: string;
  query: string;
  authorHandle: string | null;
  authorName: string | null;
  text: string;
  postedAt: string | null;
  sourceUrl: string;
  metrics: string;
};

const QUERIES = ["memecoin", "meme coin", "pumpfun"];
const COST_PER_POST_USD = 0.0002;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeTweet(tweet: SocialDataTweet, query: string, scanId: string): RawPost | null {
  const id = String(tweet.id_str ?? tweet.id ?? "");
  if (!id) return null;

  const text = tweet.full_text ?? tweet.text ?? "";
  const authorHandle = tweet.user?.screen_name ?? null;

  return {
    id,
    scanId,
    query,
    authorHandle,
    authorName: tweet.user?.name ?? null,
    text,
    postedAt: tweet.tweet_created_at ?? tweet.created_at ?? null,
    sourceUrl: authorHandle ? `https://x.com/${authorHandle}/status/${id}` : `https://x.com/i/status/${id}`,
    metrics: JSON.stringify({
      likes: tweet.favorite_count ?? 0,
      reposts: tweet.retweet_count ?? 0,
      replies: tweet.reply_count ?? 0,
      quotes: tweet.quote_count ?? 0,
    }),
  };
}

function extractTicker(text: string) {
  return text.match(/\$[A-Za-z][A-Za-z0-9]{1,14}/)?.[0]?.toUpperCase() ?? null;
}

async function insertRawPosts(db: D1Database, posts: RawPost[]) {
  if (!posts.length) return;

  const statement = db.prepare(`
    INSERT INTO raw_posts
      (tweet_id, scan_id, query, author_handle, author_name, text, posted_at, source_url, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tweet_id) DO NOTHING
  `);

  await db.batch(
    posts.map((post) =>
      statement.bind(
        post.id,
        post.scanId,
        post.query,
        post.authorHandle,
        post.authorName,
        post.text,
        post.postedAt,
        post.sourceUrl,
        post.metrics,
      ),
    ),
  );
}

async function upsertTickerNarratives(db: D1Database, posts: RawPost[]) {
  const candidates = posts
    .map((post) => ({ post, ticker: extractTicker(post.text) }))
    .filter((candidate): candidate is { post: RawPost; ticker: string } => Boolean(candidate.ticker));

  if (!candidates.length) return 0;

  const statement = db.prepare(`
    INSERT INTO narratives
      (id, name, ticker, stage, score, first_observed_at, last_observed_at, risk, created_at, updated_at)
    VALUES (?, ?, ?, '社媒初筛', 10, ?, ?, '尚未完成独立传播与链上验证', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      last_observed_at = excluded.last_observed_at,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();
  await db.batch(
    candidates.map(({ ticker }) =>
      statement.bind(
        crypto.randomUUID(),
        ticker.replace(/^\$/, ""),
        ticker,
        now,
        now,
        now,
        now,
      ),
    ),
  );

  return candidates.length;
}

async function runIngestion(env: Env, source: "manual" | "cron") {
  if (!env.SOCIALDATA_API_KEY) {
    throw new Error("SOCIALDATA_API_KEY is not configured");
  }

  const scanId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const collected: RawPost[] = [];

  await env.DB.prepare(`
    INSERT INTO scan_runs (id, source, status, post_count, candidate_count, estimated_cost_usd, started_at)
    VALUES (?, ?, 'running', 0, 0, 0, ?)
  `)
    .bind(scanId, source, startedAt)
    .run();

  for (const query of QUERIES) {
    try {
      const response = await fetch(
        `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`,
        { headers: { Authorization: `Bearer ${env.SOCIALDATA_API_KEY}` } },
      );

      if (!response.ok) {
        throw new Error(`${query}: SocialData returned ${response.status}`);
      }

      const payload = (await response.json()) as { tweets?: SocialDataTweet[] };
      for (const tweet of payload.tweets ?? []) {
        const normalized = normalizeTweet(tweet, query, scanId);
        if (normalized) collected.push(normalized);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const uniquePosts = [...new Map(collected.map((post) => [post.id, post])).values()];
  await insertRawPosts(env.DB, uniquePosts);
  const candidateCount = await upsertTickerNarratives(env.DB, uniquePosts);
  const estimatedCostUsd = uniquePosts.length * COST_PER_POST_USD;
  const completedAt = new Date().toISOString();
  const status = errors.length === QUERIES.length ? "failed" : errors.length ? "partial" : "completed";

  await env.DB.prepare(`
    UPDATE scan_runs
    SET status = ?, post_count = ?, candidate_count = ?, estimated_cost_usd = ?, completed_at = ?, errors_json = ?
    WHERE id = ?
  `)
    .bind(status, uniquePosts.length, candidateCount, estimatedCostUsd, completedAt, JSON.stringify(errors), scanId)
    .run();

  return {
    scanId,
    source,
    status,
    queries: QUERIES,
    postsRetrieved: uniquePosts.length,
    tickerSignals: candidateCount,
    estimatedCostUsd,
    errors,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "mdc-ingestion" });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const runKey = request.headers.get("X-Run-Key");
      if (!env.INGESTION_TRIGGER_SECRET || runKey !== env.INGESTION_TRIGGER_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }

      try {
        return json(await runIngestion(env, "manual"));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return json({
      service: "mdc-ingestion",
      routes: { health: "GET /health", run: "POST /run" },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIngestion(env, "cron"));
  },
};
