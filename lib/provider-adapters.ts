import { createOpportunity, type Opportunity, type SourceEvidence, type TokenCandidate } from './opportunity';

/**
 * Adapter boundaries: API routes/jobs call these functions after validating each
 * provider payload. They deliberately return a partial candidate because the
 * fusion job—not any single provider—assigns a final opportunity score/stage.
 */
export type DiscoveryFragment = {
  narrativeKey: string;
  evidence: SourceEvidence;
  tokenCandidate?: TokenCandidate;
};

export function fromSocialDataTweet(tweet: { id: string; text: string; created_at: string; author?: { username?: string }; public_metrics?: { like_count?: number } }): DiscoveryFragment {
  return {
    narrativeKey: tweet.text.slice(0, 80).toLowerCase(),
    evidence: { provider: 'socialdata', platform: 'x', label: tweet.author?.username ? `X @${tweet.author.username}` : 'X 发现记录', observedAt: tweet.created_at, url: `https://x.com/i/web/status/${tweet.id}`, metric: tweet.public_metrics?.like_count ? `${tweet.public_metrics.like_count} likes` : undefined },
  };
}

export function fromApifyPost(input: { platform: 'tiktok' | 'instagram'; url?: string; createdAt: string; author?: string; engagement?: number }): DiscoveryFragment {
  return {
    narrativeKey: input.author?.toLowerCase() ?? input.url ?? 'apify-post',
    evidence: { provider: 'apify', platform: input.platform, label: `${input.platform === 'tiktok' ? 'TikTok' : 'Instagram'} 跨平台验证`, observedAt: input.createdAt, url: input.url, metric: input.engagement ? `${input.engagement} interactions` : undefined },
  };
}

export function fromDexScreenerPair(pair: { chainId: string; dexId: string; pairAddress: string; baseToken: { address: string; symbol: string; name: string }; liquidity?: { usd?: number }; marketCap?: number; pairCreatedAt?: number }): DiscoveryFragment {
  const chain = ({ bsc: 'BNB Chain', solana: 'Solana', robinhood: 'Robinhood Chain' } as const)[pair.chainId] ?? '未确认';
  return {
    narrativeKey: `${pair.baseToken.name}:${pair.baseToken.symbol}`.toLowerCase(),
    evidence: { provider: 'dexscreener', platform: 'dex', label: `${chain} 池子捕获`, observedAt: new Date(pair.pairCreatedAt ?? Date.now()).toISOString(), metric: pair.liquidity?.usd ? `$${Math.round(pair.liquidity.usd).toLocaleString()} liquidity` : undefined },
    tokenCandidate: { chain, address: pair.baseToken.address, pairAddress: pair.pairAddress, dexId: pair.dexId, liquidityUsd: pair.liquidity?.usd, marketCapUsd: pair.marketCap, verified: false },
  };
}

export function fuseFragments(seed: Omit<Opportunity, 'sources' | 'tokenCandidates'>, fragments: DiscoveryFragment[]): Opportunity {
  return createOpportunity({ ...seed, sources: fragments.map((fragment) => fragment.evidence), tokenCandidates: fragments.flatMap((fragment) => fragment.tokenCandidate ? [fragment.tokenCandidate] : []) });
}
