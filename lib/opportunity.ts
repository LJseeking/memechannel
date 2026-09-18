/**
 * The product's source-neutral record. Provider payloads are converted to this
 * shape before they enter a queue, a historical review, or the external API.
 */
export type DataProvider = 'socialdata' | 'apify' | 'dexscreener';
export type SocialPlatform = 'x' | 'tiktok' | 'instagram';
export type Chain = 'BNB Chain' | 'Solana' | 'Robinhood Chain' | '未确认';
export type Stage = '社媒初筛' | '未发币' | '候选合约' | '刚发币待验证' | '已验证未拥挤' | '已排除';

export type SourceEvidence = {
  provider: DataProvider;
  platform: SocialPlatform | 'dex';
  label: string;
  url?: string;
  observedAt: string;
  metric?: string;
};

export type TokenCandidate = {
  chain: Chain;
  address?: string;
  pairAddress?: string;
  dexId?: string;
  liquidityUsd?: number;
  marketCapUsd?: number;
  verified: boolean;
};

export type Opportunity = {
  id: string;
  name: string;
  ticker: string;
  stage: Stage;
  score: number;
  discovered: string;
  firstObservedAt: string;
  velocity: string;
  narrative: string;
  risk: string;
  evidence: string;
  automated: string;
  sources: SourceEvidence[];
  tokenCandidates: TokenCandidate[];
};

/**
 * Normalizes only the fields the discovery system needs. Keep raw provider
 * payloads in storage separately for auditing and future parser improvements.
 */
export function createOpportunity(input: Opportunity): Opportunity {
  return {
    ...input,
    sources: [...input.sources].sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    tokenCandidates: input.tokenCandidates ?? [],
  };
}

export function providerLabel(provider: DataProvider) {
  return { socialdata: 'SocialData · X', apify: 'Apify · 跨平台', dexscreener: 'DexScreener · 链上' }[provider];
}
