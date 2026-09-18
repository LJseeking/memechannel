import { createOpportunity, type Opportunity } from './opportunity';

// Demonstration records follow the exact schema used by the ingestion service.
// No keys, provider-specific credentials, or raw social payloads belong here.
export const opportunities: Opportunity[] = [
  createOpportunity({
    id: 'bikediddy', name: 'BIKEDIDDY', ticker: '$BIKEDIDDY', stage: '社媒初筛', score: 18,
    discovered: '本轮捕获', firstObservedAt: '2026-09-16T01:11:45+08:00', velocity: '待计算',
    narrative: 'SocialData 的 “memecoin” 最新搜索捕获到 Solana 相关推广帖；当前仅有单条来源，不构成叙事确认。', risk: '单账号推广 · 尚未经过 DexScreener 池子核验', evidence: 'X @GlobalCoinHub · 0 转发 · 0 喜欢', automated: '等待独立传播',
    sources: [
      { provider: 'socialdata', platform: 'x', label: 'X 搜索：memecoin · @GlobalCoinHub', url: 'https://x.com/GlobalCoinHub/status/2099909046329557500', observedAt: '2026-09-16T01:11:45+08:00', metric: '0 转发 · 0 喜欢 · 64 浏览' },
    ], tokenCandidates: [],
  }),
  createOpportunity({
    id: 'cat-social-scan', name: 'CAT', ticker: '$CAT', stage: '社媒初筛', score: 14,
    discovered: '本轮捕获', firstObservedAt: '2026-09-16T01:11:45+08:00', velocity: '待计算',
    narrative: 'SocialData 捕获到 Solana meme 交易回顾帖。它是链上代币线索，不等于新梗或值得交易的机会。', risk: '历史收益宣传 · 未发现独立叙事证据', evidence: 'X @CiggyAlpha · 0 转发 · 0 喜欢', automated: '等待叙事去重',
    sources: [
      { provider: 'socialdata', platform: 'x', label: 'X 搜索：memecoin · @CiggyAlpha', url: 'https://x.com/CiggyAlpha/status/2099909043875615200', observedAt: '2026-09-16T01:11:45+08:00', metric: '0 转发 · 0 喜欢' },
    ], tokenCandidates: [],
  }),
  createOpportunity({
    id: 'paddog-social-scan', name: 'PADDOG', ticker: '$PADDOG', stage: '社媒初筛', score: 12,
    discovered: '本轮捕获', firstObservedAt: '2026-09-16T01:11:37+08:00', velocity: '待计算',
    narrative: 'SocialData 捕获到 Pump 生态相关收益帖。需要后续检查是否有多个独立账户讨论同一叙事。', risk: '收益喊单 · 叙事来源与代币归因均未验证', evidence: 'X @_hillscaller · 0 转发 · 0 喜欢', automated: '等待二次扫描',
    sources: [
      { provider: 'socialdata', platform: 'x', label: 'X 搜索：memecoin · @_hillscaller', url: 'https://x.com/_hillscaller/status/2099909011147501800', observedAt: '2026-09-16T01:11:37+08:00', metric: '0 转发 · 0 喜欢' },
    ], tokenCandidates: [],
  }),
  createOpportunity({
    id: 'budget-frog', name: 'Budget Frog', ticker: '$FROG', stage: '已验证未拥挤', score: 81,
    discovered: '昨天 16:42', firstObservedAt: '2026-09-15T16:42:00+08:00', velocity: '+47%',
    narrative: '原始创作者与代币社群存在明确关联，传播未出现明显拥挤。', risk: '流动性仍较薄', evidence: '合约关联已验证 · 3 个可信池', automated: '验证完成',
    sources: [
      { provider: 'socialdata', platform: 'x', label: 'X 原始叙事来源', observedAt: '2026-09-16T10:20:00+08:00', metric: '来源关联通过' },
      { provider: 'apify', platform: 'instagram', label: 'Instagram 跨平台二创验证', observedAt: '2026-09-16T10:45:00+08:00', metric: '跨平台通过' },
      { provider: 'dexscreener', platform: 'dex', label: 'Robinhood Chain 可信池', observedAt: '2026-09-16T11:44:00+08:00', metric: '3 个池' },
    ], tokenCandidates: [{ chain: 'Robinhood Chain', dexId: 'uniswap', liquidityUsd: 76000, verified: true }],
  }),
  createOpportunity({
    id: 'moon-office', name: 'Moon Office', ticker: '$MOON', stage: '已排除', score: 22,
    discovered: '昨天 13:06', firstObservedAt: '2026-09-15T13:06:00+08:00', velocity: '—',
    narrative: '传播峰值来自同一批地址的重复转发，未形成独立叙事扩散。', risk: '疑似刷量 / 同名仿盘', evidence: '风险规则命中 4 项', automated: '自动排除',
    sources: [
      { provider: 'socialdata', platform: 'x', label: 'X 异常重复转发检测', observedAt: '2026-09-16T09:30:00+08:00', metric: '风险规则 4 项' },
      { provider: 'dexscreener', platform: 'dex', label: 'BNB Chain 同名池核验', observedAt: '2026-09-16T09:38:00+08:00', metric: '未归因' },
    ], tokenCandidates: [{ chain: 'BNB Chain', dexId: 'pancakeswap', liquidityUsd: 1200, verified: false }],
  }),
];
