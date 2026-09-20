-- A ticker match alone is not a token identity. Existing ambiguous matches must
-- return to the verification queue until direct or corroborated attribution exists.
UPDATE narratives
SET
  stage = '待链上验证',
  risk = '此前仅凭同 ticker 池子匹配；缺少合约地址、官网或官方社媒交叉证据，已退回待归因验证。'
WHERE stage = '候选合约'
  AND id IN (
    SELECT narrative_id
    FROM dex_validations
    WHERE status IN ('ambiguous_match', 'single_match', 'ticker_only')
  );
