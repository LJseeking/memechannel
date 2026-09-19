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

type NarrativeAggregate = {
  postCount: number;
  scanCount: number;
  independentAuthorCount: number;
};

type EligibleNarrative = {
  id: string;
  ticker: string;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  pairCreatedAt?: number;
};

function scoreNarrative(aggregate: NarrativeAggregate) {
  let score = 10;
  if (aggregate.scanCount >= 2) score += 20;
  if (aggregate.independentAuthorCount >= 2) score += 15;
  if (aggregate.independentAuthorCount >= 3) score += 20;
  if (aggregate.postCount >= 5) score += 10;
  return Math.min(score, 75);
}

async function upsertTickerNarratives(db: D1Database, posts: RawPost[]) {
  const byTicker = new Map<string, RawPost[]>();
  for (const post of posts) {
    const ticker = extractTicker(post.text);
    if (!ticker) continue;
    byTicker.set(ticker, [...(byTicker.get(ticker) ?? []), post]);
  }

  const now = new Date().toISOString();
  const eligibleNarratives: EligibleNarrative[] = [];
  for (const [ticker, evidencePosts] of byTicker) {
    const existing = await db
      .prepare("SELECT id FROM narratives WHERE ticker = ? ORDER BY first_seen_at ASC LIMIT 1")
      .bind(ticker)
      .first<{ id: string }>();

    const narrativeId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      const firstPost = evidencePosts[0];
      await db
        .prepare(`
          INSERT INTO narratives
            (id, name, ticker, stage, score, first_seen_at, last_seen_at, independent_author_count, post_count, summary, risk)
          VALUES (?, ?, ?, '社媒初筛', 10, ?, ?, 0, 0, ?, '尚未完成独立传播与链上验证')
        `)
        .bind(
          narrativeId,
          ticker.replace(/^\$/, ""),
          ticker,
          now,
          now,
          `首次由 X 查询“${firstPost.query}”发现。`,
        )
        .run();
    }

    await db.batch(
      evidencePosts.map((post) =>
        db
          .prepare(`
            INSERT OR IGNORE INTO narrative_evidence
              (narrative_id, tweet_id, scan_id, author_handle, observed_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(narrativeId, post.id, post.scanId, post.authorHandle, now),
      ),
    );

    const aggregate = await db
      .prepare(`
        SELECT
          COUNT(*) AS postCount,
          COUNT(DISTINCT scan_id) AS scanCount,
          COUNT(DISTINCT author_handle) AS independentAuthorCount
        FROM narrative_evidence
        WHERE narrative_id = ?
      `)
      .bind(narrativeId)
      .first<NarrativeAggregate>();

    const evidence = aggregate ?? { postCount: 0, scanCount: 0, independentAuthorCount: 0 };
    const meetsDexThreshold = evidence.scanCount >= 2 && evidence.independentAuthorCount >= 3;
    const stage = meetsDexThreshold ? "待链上验证" : "社媒初筛";
    const risk = meetsDexThreshold
      ? "已满足社媒独立传播阈值；尚未完成 DexScreener 链上验证"
      : "尚未完成跨扫描与独立传播验证";

    await db
      .prepare(`
        UPDATE narratives
        SET stage = ?, score = ?, last_seen_at = ?, independent_author_count = ?, post_count = ?,
            summary = ?, risk = ?
        WHERE id = ?
      `)
      .bind(
        stage,
        scoreNarrative(evidence),
        now,
        evidence.independentAuthorCount,
        evidence.postCount,
        `已收集 ${evidence.postCount} 条独立帖子，来自 ${evidence.independentAuthorCount} 个账号，覆盖 ${evidence.scanCount} 次扫描。`,
        risk,
        narrativeId,
      )
      .run();

    if (meetsDexThreshold) eligibleNarratives.push({ id: narrativeId, ticker });
  }

  return { tickerSignals: byTicker.size, eligibleForDex: eligibleNarratives };
}

function asIsoTimestamp(timestamp: number | undefined) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

async function validateWithDexScreener(db: D1Database, scanId: string, narrative: EligibleNarrative) {
  const symbol = narrative.ticker.replace(/^\$/, "");
  const queriedAt = new Date().toISOString();
  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`,
  );

  if (!response.ok) {
    throw new Error(`${narrative.ticker}: DexScreener returned ${response.status}`);
  }

  const payload = (await response.json()) as { pairs?: DexPair[] };
  const exactPairs = (payload.pairs ?? [])
    .filter((pair) => pair.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase())
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))
    .slice(0, 10);

  const status = exactPairs.length === 0 ? "no_exact_pair" : exactPairs.length === 1 ? "single_match" : "ambiguous_match";
  const insert = db.prepare(`
    INSERT INTO dex_validations
      (id, narrative_id, scan_id, ticker, status, queried_at, chain_id, dex_id, pair_address,
       token_address, token_symbol, liquidity_usd, volume_h24_usd, market_cap_usd,
       pair_created_at, source_url, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (!exactPairs.length) {
    await insert
      .bind(
        crypto.randomUUID(), narrative.id, scanId, narrative.ticker, status, queriedAt,
        null, null, null, null, null, null, null, null, null, null,
        JSON.stringify({ pairCount: payload.pairs?.length ?? 0 }),
      )
      .run();
    await db
      .prepare("UPDATE narratives SET stage = '未发币', risk = ? WHERE id = ?")
      .bind("DexScreener 未找到 ticker 的精确基础代币匹配；继续跟踪社媒传播。", narrative.id)
      .run();
    return;
  }

  await db.batch(
    exactPairs.map((pair) =>
      insert.bind(
        crypto.randomUUID(), narrative.id, scanId, narrative.ticker, status, queriedAt,
        pair.chainId ?? null, pair.dexId ?? null, pair.pairAddress ?? null,
        pair.baseToken?.address ?? null, pair.baseToken?.symbol ?? null,
        pair.liquidity?.usd ?? null, pair.volume?.h24 ?? null, pair.marketCap ?? null,
        asIsoTimestamp(pair.pairCreatedAt), pair.url ?? null, JSON.stringify(pair),
      ),
    ),
  );

  await db
    .prepare("UPDATE narratives SET stage = '候选合约', risk = ? WHERE id = ?")
    .bind(
      status === "single_match"
        ? "发现一个 ticker 精确匹配池子；仍需核对合约与叙事来源，不能视为已验证。"
        : "发现多个同 ticker 池子；合约存在歧义，不能自动认定为同一项目。",
      narrative.id,
    )
    .run();
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
  const narrativeResult = await upsertTickerNarratives(env.DB, uniquePosts);
  for (const narrative of narrativeResult.eligibleForDex) {
    try {
      await validateWithDexScreener(env.DB, scanId, narrative);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const estimatedCostUsd = uniquePosts.length * COST_PER_POST_USD;
  const completedAt = new Date().toISOString();
  const status = errors.length === QUERIES.length ? "failed" : errors.length ? "partial" : "completed";

  await env.DB.prepare(`
    UPDATE scan_runs
    SET status = ?, post_count = ?, candidate_count = ?, estimated_cost_usd = ?, finished_at = ?, error_message = ?
    WHERE id = ?
  `)
    .bind(status, uniquePosts.length, narrativeResult.tickerSignals, estimatedCostUsd, completedAt, errors.join(" | ") || null, scanId)
    .run();

  return {
    scanId,
    source,
    status,
    queries: QUERIES,
    postsRetrieved: uniquePosts.length,
    tickerSignals: narrativeResult.tickerSignals,
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
