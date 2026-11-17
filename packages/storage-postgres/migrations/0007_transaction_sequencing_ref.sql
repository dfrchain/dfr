-- DFR M3-B03：交易记录承载链无关的排序前提（ADR-033，方案 A）
--
-- 背景：`transactions.nonce` 只能表达 EVM 的序号语义；Solana 的排序前提是 recent
-- blockhash（ADR-032）。把 blockhash 塞进 numeric(78,0) 的 nonce 列违反 ADR-032 红线，
-- 因此新增一列链无关的判别联合引用。
--
-- 为什么用 jsonb 而不是加列：排序前提的形状随链而异（nonce 是标量；blockhash 附带
-- lastValidBlockHeight）。判别联合的合法形状由 CHECK 约束固定，避免无 schema 的 blob。
--
-- 前向迁移：只 ADD COLUMN，可空，不动历史行；`nonce` 列保留（EVM 现有代码与索引不动）。
-- 对 EVM 记录，应用层要求 sequencing_ref->>'value' = nonce（写入路径校验，见
-- transaction-store.ts 的 assertSequencingRefMatchesNonce）。

ALTER TABLE transaction_data.transactions
  ADD COLUMN IF NOT EXISTS sequencing_ref jsonb;

-- 形状约束（历史行 NULL 不受影响）：
--   nonce     → { kind:"nonce", value:"<十进制>" }，且不得带 lastValidBlockHeight
--   blockhash → { kind:"blockhash", value:"<base58>", lastValidBlockHeight:"<十进制>" }
ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_sequencing_ref_shape
  CHECK (
    sequencing_ref IS NULL
    OR COALESCE(
      jsonb_typeof(sequencing_ref) = 'object'
      -- value 必须是字符串（缺 key / 非字符串都判失败，不能靠 NULL 通过）。
      AND COALESCE(jsonb_typeof(sequencing_ref->'value') = 'string', false)
      AND COALESCE(
        -- 用 jsonb_exists() 而不是 `?`：后者与 NOT 的优先级易出错。
        (sequencing_ref->>'kind' = 'nonce'
          AND NOT jsonb_exists(sequencing_ref, 'lastValidBlockHeight'))
        OR (
          sequencing_ref->>'kind' = 'blockhash'
          AND COALESCE(jsonb_typeof(sequencing_ref->'lastValidBlockHeight') = 'string', false)
        ),
        false
      ),
      false
    )
  );
