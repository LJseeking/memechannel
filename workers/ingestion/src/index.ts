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
      (tweet_id, scan_id, query_text, author_handle, posted_at, content, metrics_json, source_url, ingested_at)
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
        post.postedAt,
        post.text,
        post.metrics,
        post.sourceUrl,
        new Date().toISOString(),
      ),
    ),
  );
}

async function upsertTickerNarratives(db: D1Database, posts: RawPost[]) {
  const candidates = posts
    .map((post) => ({ post, ticker: extractTicker(post.text) }))
    .filter((candidate): candidate is { post: RawPost; ticker: string } => Boolean(candidate.ticker));

  if (!candidates.length) return 0;

  const now = new Date().toISOString();
  for (const { ticker, post } of candidates) {
    const existing = await db
      .prepare("SELECT id FROM narratives WHERE ticker = ? ORDER BY first_seen_at ASC LIMIT 1")
      .bind(ticker)
      .first<{ id: string }>();

    if (existing) {
      await db
        .prepare(`
          UPDATE narratives
          SET last_seen_at = ?, post_count = post_count + 1
          WHERE id = ?
        `)
        .bind(now, existing.id)
        .run();
      continue;
    }

    await db
      .prepare(`
        INSERT INTO narratives
          (id, name, ticker, stage, score, first_seen_at, last_seen_at, independent_author_count, post_count, summary, risk)
        VALUES (?, ?, ?, '社媒初筛', 10, ?, ?, ?, 1, ?, '尚未完成独立传播与链上验证')
      `)
      .bind(
        crypto.randomUUID(),
        ticker.replace(/^\$/, ""),
        ticker,
        now,
        now,
        post.authorHandle ? 1 : 0,
        `首次由 X 查询“${post.query}”发现。`,
      )
      .run();
  }

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
    INSERT INTO scan_runs (id, source, status, query_count, post_count, candidate_count, estimated_cost_usd, started_at)
    VALUES (?, ?, 'running', ?, 0, 0, 0, ?)
  `)
    .bind(scanId, source, QUERIES.length, startedAt)
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
    SET status = ?, post_count = ?, candidate_count = ?, estimated_cost_usd = ?, finished_at = ?, error_message = ?
    WHERE id = ?
  `)
    .bind(status, uniquePosts.length, candidateCount, estimatedCostUsd, completedAt, errors.join(" | ") || null, scanId)
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
