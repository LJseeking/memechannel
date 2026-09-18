/**
 * Non-secret provider identifiers used by ingestion jobs. Credentials must stay
 * in Cloudflare Worker secrets (APIFY_API_TOKEN / SOCIALDATA_API_KEY), never in
 * this repository or browser code.
 */
export const apifyActors = {
  instagram: {
    id: 'shu8hvrXbJbY3Eb9W',
    name: 'apify/instagram-scraper',
    endpoint: 'https://api.apify.com/v2/acts/shu8hvrXbJbY3Eb9W/runs',
    role: '仅用于高分候选的 Instagram / Reels 跨平台验证',
  },
  tiktok: {
    id: 'GdWCkxBtKWOsKjdch',
    name: 'clockworks/tiktok-scraper',
    endpoint: 'https://api.apify.com/v2/acts/GdWCkxBtKWOsKjdch/runs',
    role: '仅用于高分候选的 TikTok 传播与二创验证',
  },
} as const;

export const socialDataConfig = {
  endpoint: 'https://api.socialdata.tools/twitter/search',
  role: '每三小时运行的 X 发现层',
} as const;

export const dexScreenerConfig = {
  endpoint: 'https://api.dexscreener.com/latest/dex/search',
  role: '多链代币、交易池与流动性验证层',
} as const;
