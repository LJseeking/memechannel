-- A generic ticker cannot identify one project or one contract. Keep its social
-- observations, but remove it from the contract-candidate pipeline.
UPDATE narratives
SET stage = '社媒初筛',
    risk = '泛用资产 ticker，不参与候选合约归因或 DexScreener 自动晋级。'
WHERE ticker IN ('$BTC', '$ETH', '$SOL', '$BNB', '$USDT', '$USDC', '$XRP', '$DOGE');
