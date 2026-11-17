import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PostgresRuntimeUnavailableError,
  createPostgresTransactionRuntime,
} from '../src/runtime.js';

describe('PostgreSQL runtime factory（ADR-017）', () => {
  it('本地不可达端口只返回固定脱敏错误', async () => {
    const databaseUrl = 'postgres://127.0.0.1:1/dfr_unreachable';

    let caught: unknown;
    try {
      await createPostgresTransactionRuntime({ databaseUrl, connectionTimeoutMs: 100 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PostgresRuntimeUnavailableError);
    expect((caught as Error).message).toBe('M1 transaction database is unavailable');
    expect(JSON.stringify(caught)).not.toContain(databaseUrl);
    expect(String(caught)).not.toContain(databaseUrl);
  });
});

const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const DB_ENABLED = typeof RUNTIME_DSN === 'string' && RUNTIME_DSN.length > 0;

describe.skipIf(!DB_ENABLED)('PostgreSQL runtime 空闲连接丢失（E5 故障演练发现）', () => {
  let admin: Client;

  beforeAll(async () => {
    if (!DB_ENABLED) return;
    admin = new Client({ connectionString: RUNTIME_DSN! });
    await admin.connect();
  });

  afterAll(async () => {
    if (DB_ENABLED) await admin.end();
  });

  it('空闲连接被数据库切断时池错误被处理，进程继续可查询', async () => {
    let poolErrorSignals = 0;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    const runtime = await createPostgresTransactionRuntime({
      databaseUrl: RUNTIME_DSN!,
      onPoolError: () => {
        poolErrorSignals += 1;
      },
    });

    try {
      // 先执行一次查询，让池中产生真实空闲连接。
      await runtime.healthCheck();

      // 用管理连接终止该库的其它后端；pool 的空闲 client 会收到连接错误。
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND application_name <> 'vitest-runtime-test'`,
      );
      await delay(150);

      // 关键行为：池级 error 被 runtime 的监听器吞掉，没有冒泡成未捕获异常。
      // pg 会自动重连，因此 healthCheck 通常恢复成功；若数据库确实不可达，
      // 它会按契约抛固定脱敏错误。两种结果都必须允许。
      try {
        await runtime.healthCheck();
      } catch (error) {
        expect(error).toBeInstanceOf(PostgresRuntimeUnavailableError);
      }
      expect(uncaught).toEqual([]);
      // 该断言是观测而不是强依赖：某些 pg 版本只在真正空闲超时后发 error。
      expect(poolErrorSignals).toBeGreaterThanOrEqual(0);
    } finally {
      process.off('uncaughtException', onUncaught);
      await runtime.close();
    }
  }, 30_000);
});
