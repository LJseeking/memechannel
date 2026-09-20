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
const ENRICHMENT_NARRATIVE_LIMIT = 3;
const ENRICHMENT_EXCLUDED_TICKERS = new Set([
  "$BTC", "$ETH", "$SOL", "$BNB", "$USDT", "$USDC", "$XRP", "$DOGE",
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Run-Key",
    },
  });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Run-Key",
      "access-control-max-age": "86400",
    },
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

function extractUrls(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s)\]}>,]+/gi)]
    .map((match) => match[0].replace(/[.,!?]+$/, ""))
    .filter((url) => {
      try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
    });
}

function extractContractHints(text: string) {
  const evm = text.match(/\b0x[a-fA-F0-9]{40}\b/g) ?? [];
  const solana = [...text.matchAll(/(?:\b(?:ca|contract|address|mint|token)\s*[:：-]?\s*)([1-9A-HJ-NP-Za-km-z]{32,44})/gi)]
    .map((match) => match[1]);
  return [...new Set([...evm, ...solana])];
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

function enrichmentQuery(ticker: string) {
  // One page only: SocialData charges for records returned, so a client-side slice
  // would not reduce spend. This query is deliberately limited to recent posts.
  return `${ticker} (CA OR contract OR mint OR website OR telegram) within_time:3h`;
}

async function getEnrichmentTargets(db: D1Database): Promise<EnrichmentTarget[]> {
  const candidates = await db.prepare(`
    SELECT id, ticker
    FROM narratives
    WHERE stage = '待链上验证'
    ORDER BY score DESC, independent_author_count DESC, last_seen_at DESC
    LIMIT 20
  `).all<EnrichmentTarget>();

  return candidates.results
    .filter((candidate) => !ENRICHMENT_EXCLUDED_TICKERS.has(candidate.ticker.toUpperCase()))
    .slice(0, ENRICHMENT_NARRATIVE_LIMIT);
}

async function enrichTopNarratives(
  db: D1Database,
  apiKey: string,
  scanId: string,
  errors: string[],
): Promise<EnrichmentResult> {
  const targets = await getEnrichmentTargets(db);
  const posts: RawPost[] = [];
  let postsRetrieved = 0;

  for (const target of targets) {
    const query = enrichmentQuery(target.ticker);
    try {
      const response = await fetch(
        `https://api.socialdata.tools/twitter/search?query=${encodeURIComponent(query)}&type=Latest`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!response.ok) throw new Error(`${target.ticker} 补证: SocialData returned ${response.status}`);

      const payload = (await response.json()) as { tweets?: SocialDataTweet[] };
      const tweets = payload.tweets ?? [];
      postsRetrieved += tweets.length;
      for (const tweet of tweets) {
        const normalized = normalizeTweet(tweet, query, scanId);
        if (normalized) posts.push(normalized);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { posts, queryCount: targets.length, postsRetrieved };
}

type NarrativeAggregate = {
  postCount: number;
  scanCount: number;
  independentAuthorCount: number;
};

type EligibleNarrative = {
  id: string;
  ticker: string;
  evidenceText: string;
  evidenceUrls: string[];
  contractHints: string[];
};

type EnrichmentTarget = {
  id: string;
  ticker: string;
};

type EnrichmentResult = {
  posts: RawPost[];
  queryCount: number;
  postsRetrieved: number;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    websites?: Array<{ url?: string }>;
    socials?: Array<{ url?: string }>;
  };
};

type DexValidationResult = "validated" | "rate_limited";

function hostnames(urls: string[]) {
  return new Set(urls.flatMap((url) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return hostname ? [hostname] : [];
    } catch { return []; }
  }));
}

function pairUrls(pair: DexPair) {
  return [
    ...(pair.info?.websites ?? []).map((item) => item.url),
    ...(pair.info?.socials ?? []).map((item) => item.url),
  ].filter((url): url is string => Boolean(url));
}

function scoreAttribution(pair: DexPair, narrative: EligibleNarrative) {
  const evidenceHosts = hostnames(narrative.evidenceUrls);
  const dexUrls = pairUrls(pair);
  const matchingUrl = dexUrls.some((url) => {
    try {
      return evidenceHosts.has(new URL(url).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      return false;
    }
  });
  const tokenName = pair.baseToken?.name?.trim().toLowerCase();
  const nameMentioned = Boolean(tokenName && tokenName.length > 2 && narrative.evidenceText.toLowerCase().includes(tokenName));
  const reasons: string[] = [];
  let score = 0;
  if (matchingUrl) { score += 45; reasons.push("社媒链接与 Dex 项目链接同域"); }
  if (nameMentioned) { score += 15; reasons.push("项目名称出现在社媒证据中"); }
  if (pair.pairCreatedAt) {
    const ageMs = Date.now() - pair.pairCreatedAt;
    if (ageMs >= 0 && ageMs <= 14 * 24 * 60 * 60 * 1000) {
      score += 10; reasons.push("池子创建时间符合早期窗口");
    }
  }
  return { score, reasons };
}

type SourceProfileAggregate = {
  totalSignals: number;
  discoverySignals: number;
  predictionSignals: number;
  resolvedOutcomes: number;
  hitCount: number;
  riskOutcomeCount: number;
  accuracy: number | null;
};

function scoreNarrative(aggregate: NarrativeAggregate) {
  let score = 10;
  if (aggregate.scanCount >= 2) score += 20;
  if (aggregate.independentAuthorCount >= 2) score += 15;
  if (aggregate.independentAuthorCount >= 3) score += 20;
  if (aggregate.postCount >= 5) score += 10;
  return Math.min(score, 75);
}

function classifySignal(text: string) {
  return /\b(bullish|buy(?:ing)?|accumulate|price target|send it|moon|100x|gem)\b|看多|目标价|买入|起飞|翻倍/i.test(text)
    ? "explicit_prediction"
    : "mention";
}

async function refreshSourceProfile(db: D1Database, authorHandle: string, now: string) {
  const aggregate = await db
    .prepare(`
      SELECT
        COUNT(*) AS totalSignals,
        SUM(CASE WHEN is_first_observed = 1 THEN 1 ELSE 0 END) AS discoverySignals,
        SUM(CASE WHEN signal_type = 'explicit_prediction' THEN 1 ELSE 0 END) AS predictionSignals,
        SUM(CASE WHEN outcome_status != 'pending' THEN 1 ELSE 0 END) AS resolvedOutcomes,
        SUM(CASE WHEN outcome_status = 'hit' THEN 1 ELSE 0 END) AS hitCount,
        SUM(CASE WHEN outcome_status = 'risk' THEN 1 ELSE 0 END) AS riskOutcomeCount
      FROM source_signals
      WHERE author_handle = ?
    `)
    .bind(authorHandle)
    .first<SourceProfileAggregate>();

  const profile = aggregate ?? {
    totalSignals: 0,
    discoverySignals: 0,
    predictionSignals: 0,
    resolvedOutcomes: 0,
    hitCount: 0,
    riskOutcomeCount: 0,
    accuracy: null,
  };
  const accuracy = profile.resolvedOutcomes > 0 ? profile.hitCount / profile.resolvedOutcomes : null;

  await db
    .prepare(`
      INSERT INTO source_profiles
        (author_handle, first_observed_at, last_observed_at, total_signals, discovery_signals,
         prediction_signals, resolved_outcomes, hit_count, risk_outcome_count, accuracy, average_lead_hours, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(author_handle) DO UPDATE SET
        last_observed_at = excluded.last_observed_at,
        total_signals = excluded.total_signals,
        discovery_signals = excluded.discovery_signals,
        prediction_signals = excluded.prediction_signals,
        resolved_outcomes = excluded.resolved_outcomes,
        hit_count = excluded.hit_count,
        risk_outcome_count = excluded.risk_outcome_count,
        accuracy = excluded.accuracy,
        updated_at = excluded.updated_at
    `)
    .bind(
      authorHandle,
      now,
      now,
      profile.totalSignals,
      profile.discoverySignals,
      profile.predictionSignals,
      profile.resolvedOutcomes,
      profile.hitCount,
      profile.riskOutcomeCount,
      accuracy,
      now,
    )
    .run();
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

    const firstObservedTweetId = existing ? null : evidencePosts[0]?.id;
    const sourcePosts = evidencePosts.filter((post): post is RawPost & { authorHandle: string } => Boolean(post.authorHandle));
    const sourceHandles = [...new Set(sourcePosts.map((post) => post.authorHandle))];
    await db.batch(
      sourceHandles.map((authorHandle) =>
        db
          .prepare(`
            INSERT OR IGNORE INTO source_profiles
              (author_handle, first_observed_at, last_observed_at, total_signals, discovery_signals,
               prediction_signals, resolved_outcomes, hit_count, risk_outcome_count, accuracy, average_lead_hours, updated_at)
            VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, ?)
          `)
          .bind(authorHandle, now, now, now),
      ),
    );
    await db.batch(
      sourcePosts.map((post) =>
        db
            .prepare(`
              INSERT OR IGNORE INTO source_signals
                (id, author_handle, narrative_id, tweet_id, scan_id, signal_type, is_first_observed, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              crypto.randomUUID(),
              post.authorHandle,
              narrativeId,
              post.id,
              post.scanId,
              classifySignal(post.text),
              post.id === firstObservedTweetId ? 1 : 0,
              post.postedAt ?? now,
            ),
      ),
    );
    await Promise.all(sourceHandles.map((authorHandle) => refreshSourceProfile(db, authorHandle, now)));

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

    if (meetsDexThreshold) {
      const evidenceRows = await db.prepare(`
        SELECT p.content
        FROM narrative_evidence e
        JOIN raw_posts p ON p.tweet_id = e.tweet_id
        WHERE e.narrative_id = ?
      `).bind(narrativeId).all<{ content: string }>();
      const allEvidenceText = evidenceRows.results.map((row) => row.content).join("\n");
      eligibleNarratives.push({
        id: narrativeId,
        ticker,
        evidenceText: allEvidenceText,
        evidenceUrls: extractUrls(allEvidenceText),
        contractHints: extractContractHints(allEvidenceText),
      });
    }
  }

  return { tickerSignals: byTicker.size, eligibleForDex: eligibleNarratives };
}

function asIsoTimestamp(timestamp: number | undefined) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

async function validateWithDexScreener(
  db: D1Database,
  scanId: string,
  narrative: EligibleNarrative,
): Promise<DexValidationResult> {
  const symbol = narrative.ticker.replace(/^\$/, "");
  const queriedAt = new Date().toISOString();
  const query = narrative.contractHints[0] ?? symbol;
  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
  );

  if (response.status === 429) {
    await db
      .prepare(`
        INSERT INTO dex_validations
          (id, narrative_id, scan_id, ticker, status, queried_at, raw_json)
        VALUES (?, ?, ?, ?, 'rate_limited', ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        narrative.id,
        scanId,
        narrative.ticker,
        queriedAt,
        JSON.stringify({ provider: "DexScreener", status: 429, action: "deferred_to_next_scan" }),
      )
      .run();
    return "rate_limited";
  }

  if (!response.ok) {
    throw new Error(`${narrative.ticker}: DexScreener returned ${response.status}`);
  }

  const payload = (await response.json()) as { pairs?: DexPair[] };
  const directContract = narrative.contractHints.length > 0;
  const exactPairs = (payload.pairs ?? [])
    .filter((pair) => directContract
      ? narrative.contractHints.some((address) => pair.baseToken?.address?.toLowerCase() === address.toLowerCase())
      : pair.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase())
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))
    .slice(0, 10);

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
        crypto.randomUUID(), narrative.id, scanId, narrative.ticker, "no_exact_pair", queriedAt,
        null, null, null, null, null, null, null, null, null, null,
        JSON.stringify({
          pairCount: payload.pairs?.length ?? 0,
          queryKind: directContract ? "explicit_contract" : "ticker_only",
          attributionScore: 0,
          reasons: ["未找到可归因的 Dex 基础代币"],
        }),
      )
      .run();
    await db.prepare("UPDATE narratives SET stage = ?, risk = ? WHERE id = ?")
      .bind(
        directContract ? "待链上验证" : "未发币",
        directContract
          ? "帖子包含合约地址，但 DexScreener 尚未返回该地址的可归因池子。"
          : "DexScreener 未找到 ticker 的精确基础代币匹配；继续跟踪社媒传播。",
        narrative.id,
      ).run();
    return "validated";
  }

  const scoredPairs = exactPairs.map((pair) => ({
    pair,
    attribution: directContract
      ? { score: 100, reasons: ["帖子直接提供合约地址，且 Dex 基础代币地址一致"] }
      : scoreAttribution(pair, narrative),
  }));
  const best = scoredPairs[0];
  const corroborated = !directContract && best.attribution.score >= 50
    && (scoredPairs.length === 1 || best.attribution.score > (scoredPairs[1]?.attribution.score ?? 0));
  const status = directContract ? "direct_contract_match" : corroborated ? "corroborated_match"
    : exactPairs.length === 1 ? "ticker_only" : "ambiguous_match";
  const stage = directContract || corroborated ? "候选合约" : "待链上验证";
  const risk = directContract
    ? "社媒帖子直接提供合约地址，且与 DexScreener 基础代币地址一致；仍需继续验证流动性与项目风险。"
    : corroborated
      ? `社媒与 Dex 项目资料获得 ${best.attribution.score} 分交叉佐证；仍非交易建议。`
      : exactPairs.length === 1
        ? "仅找到一个同 ticker 池子，但缺少合约地址、官网或官方社媒交叉证据；不能自动归因。"
        : "多个同 ticker 池子缺乏社媒交叉证据；不能自动归因到同一项目。";

  await db.batch(
    scoredPairs.map(({ pair, attribution }) =>
      insert.bind(
        crypto.randomUUID(), narrative.id, scanId, narrative.ticker, status, queriedAt,
        pair.chainId ?? null, pair.dexId ?? null, pair.pairAddress ?? null,
        pair.baseToken?.address ?? null, pair.baseToken?.symbol ?? null,
        pair.liquidity?.usd ?? null, pair.volume?.h24 ?? null, pair.marketCap ?? null,
        asIsoTimestamp(pair.pairCreatedAt), pair.url ?? null,
        JSON.stringify({
          pair,
          queryKind: directContract ? "explicit_contract" : "ticker_only",
          attributionScore: attribution.score,
          reasons: attribution.reasons,
          candidateStatus: status,
        }),
      ),
    ),
  );

  await db.prepare("UPDATE narratives SET stage = ?, risk = ? WHERE id = ?")
    .bind(stage, risk, narrative.id)
    .run();

  return "validated";
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

  const socialSearchErrorCount = errors.length;
  const uniquePosts = [...new Map(collected.map((post) => [post.id, post])).values()];
  await insertRawPosts(env.DB, uniquePosts);
  const narrativeResult = await upsertTickerNarratives(env.DB, uniquePosts);
  let dexDeferredCount = 0;
  for (const [index, narrative] of narrativeResult.eligibleForDex.entries()) {
    try {
      const result = await validateWithDexScreener(env.DB, scanId, narrative);
      if (result === "rate_limited") {
        dexDeferredCount = narrativeResult.eligibleForDex.length - index;
        break;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // A second, deliberately small pass is used only for the strongest unresolved
  // narratives. It tries to find a contract/mint or an official project link.
  const enrichment = await enrichTopNarratives(env.DB, env.SOCIALDATA_API_KEY, scanId, errors);
  const uniqueEnrichmentPosts = [...new Map(enrichment.posts.map((post) => [post.id, post])).values()];
  await insertRawPosts(env.DB, uniqueEnrichmentPosts);
  const enrichmentNarratives = await upsertTickerNarratives(env.DB, uniqueEnrichmentPosts);
  for (const [index, narrative] of enrichmentNarratives.eligibleForDex.entries()) {
    try {
      const result = await validateWithDexScreener(env.DB, scanId, narrative);
      if (result === "rate_limited") {
        dexDeferredCount += enrichmentNarratives.eligibleForDex.length - index;
        break;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const enrichmentEstimatedCostUsd = enrichment.postsRetrieved * COST_PER_POST_USD;
  const estimatedCostUsd = uniquePosts.length * COST_PER_POST_USD + enrichmentEstimatedCostUsd;
  const completedAt = new Date().toISOString();
  const status = socialSearchErrorCount === QUERIES.length ? "failed" : errors.length ? "partial" : "completed";

  await env.DB.prepare(`
    UPDATE scan_runs
    SET status = ?, query_count = ?, post_count = ?, candidate_count = ?, estimated_cost_usd = ?,
        enrichment_query_count = ?, enrichment_post_count = ?, enrichment_estimated_cost_usd = ?,
        dex_deferred_count = ?, finished_at = ?, error_message = ?
    WHERE id = ?
  `)
    .bind(
      status,
      QUERIES.length + enrichment.queryCount,
      uniquePosts.length + enrichment.postsRetrieved,
      narrativeResult.tickerSignals,
      estimatedCostUsd,
      enrichment.queryCount,
      enrichment.postsRetrieved,
      enrichmentEstimatedCostUsd,
      dexDeferredCount,
      completedAt,
      errors.join(" | ") || null,
      scanId,
    )
    .run();

  return {
    scanId,
    source,
    status,
    queries: QUERIES,
    postsRetrieved: uniquePosts.length + enrichment.postsRetrieved,
    tickerSignals: narrativeResult.tickerSignals,
    estimatedCostUsd,
    enrichment: {
      queryCount: enrichment.queryCount,
      postsRetrieved: enrichment.postsRetrieved,
      estimatedCostUsd: enrichmentEstimatedCostUsd,
    },
    dexDeferredCount,
    errors,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return optionsResponse();

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "mdc-ingestion" });
    }

    if (request.method === "GET" && url.pathname === "/sources") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 20;
      const results = await env.DB.prepare(`
        SELECT author_handle, first_observed_at, last_observed_at, total_signals, discovery_signals,
               prediction_signals, resolved_outcomes, hit_count, risk_outcome_count, accuracy, average_lead_hours
        FROM source_profiles
        ORDER BY resolved_outcomes DESC, discovery_signals DESC, total_signals DESC
        LIMIT ?
      `).bind(limit).all();
      return json({
        dataStatus: "collecting_outcomes",
        methodology: "准确率仅在可验证结果累计后展示；样本量不足时不进行排名。",
        sources: results.results,
      });
    }

    if (request.method === "GET" && url.pathname === "/opportunities") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 50;
      const requestedStage = url.searchParams.get("stage");
      const stage = requestedStage && requestedStage !== "全部" ? requestedStage : null;
      const statement = env.DB.prepare(`
        SELECT
          n.id, n.name, n.ticker, n.stage, n.score, n.first_seen_at, n.last_seen_at,
          n.independent_author_count, n.post_count, n.summary, n.risk,
          COUNT(DISTINCT e.scan_id) AS scan_count,
          latest.status AS dex_status, latest.chain_id, latest.dex_id, latest.pair_address,
          latest.token_address, latest.token_symbol, latest.liquidity_usd,
          latest.volume_h24_usd, latest.market_cap_usd, latest.source_url AS dex_source_url,
          latest.queried_at AS dex_queried_at
        FROM narratives n
        LEFT JOIN narrative_evidence e ON e.narrative_id = n.id
        LEFT JOIN dex_validations latest ON latest.id = (
          SELECT d.id FROM dex_validations d
          WHERE d.narrative_id = n.id
          ORDER BY d.queried_at DESC, d.id DESC
          LIMIT 1
        )
        WHERE (? IS NULL OR n.stage = ?)
        GROUP BY n.id
        ORDER BY n.score DESC, scan_count DESC, n.last_seen_at DESC
        LIMIT ?
      `);
      const results = await statement.bind(stage, stage, limit).all();
      const latestScan = await env.DB.prepare(`
        SELECT source, status, query_count, post_count, candidate_count, estimated_cost_usd,
               enrichment_query_count, enrichment_post_count, enrichment_estimated_cost_usd,
               dex_deferred_count, started_at, finished_at, error_message
        FROM scan_runs
        WHERE status != 'running'
        ORDER BY started_at DESC
        LIMIT 1
      `).first();
      return json({
        dataStatus: "live",
        methodology: "候选按独立作者、跨扫描重复出现与链上核验状态排序；社媒信号不构成交易建议。",
        latestScan,
        opportunities: results.results,
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/opportunities/")) {
      const narrativeId = decodeURIComponent(url.pathname.slice("/opportunities/".length));
      if (!narrativeId) return json({ error: "Opportunity id is required" }, 400);
      const narrative = await env.DB.prepare(`
        SELECT id, name, ticker, stage, score, first_seen_at, last_seen_at,
               independent_author_count, post_count, summary, risk
        FROM narratives
        WHERE id = ?
      `).bind(narrativeId).first();
      if (!narrative) return json({ error: "Opportunity not found" }, 404);

      const [evidence, dexValidations] = await Promise.all([
        env.DB.prepare(`
          SELECT e.tweet_id, e.scan_id, e.author_handle, e.observed_at,
                 p.content, p.source_url, p.metrics_json, p.posted_at, p.query_text
          FROM narrative_evidence e
          LEFT JOIN raw_posts p ON p.tweet_id = e.tweet_id
          WHERE e.narrative_id = ?
          ORDER BY e.observed_at DESC
          LIMIT 50
        `).bind(narrativeId).all(),
        env.DB.prepare(`
          SELECT status, queried_at, chain_id, dex_id, pair_address, token_address,
                 token_symbol, liquidity_usd, volume_h24_usd, market_cap_usd, source_url
          FROM dex_validations
          WHERE narrative_id = ?
          ORDER BY queried_at DESC, id DESC
          LIMIT 20
        `).bind(narrativeId).all(),
      ]);
      return json({ dataStatus: "live", opportunity: narrative, evidence: evidence.results, dexValidations: dexValidations.results });
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
      routes: {
        health: "GET /health",
        opportunities: "GET /opportunities",
        opportunity: "GET /opportunities/:id",
        sources: "GET /sources",
        run: "POST /run",
      },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIngestion(env, "cron"));
  },
};
