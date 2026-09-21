import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export type { QueryResult, QueryResultRow };

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(callback: (tx: DatabaseClient) => Promise<T>): Promise<T>;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

class PoolDatabaseClient implements DatabaseClient {
  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      return await client.query<T>(sql, params as unknown[]);
    } finally {
      client.release();
    }
  }

  async transaction<T>(callback: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txClient: DatabaseClient = {
        query: <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          params?: readonly unknown[],
        ) => client.query<T>(sql, params as unknown[]),
        transaction: <T2>(cb: (tx: DatabaseClient) => Promise<T2>) => cb(txClient),
      };
      const result = await callback(txClient);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

class TxDatabaseClient implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(sql, params as unknown[]);
  }

  async transaction<T>(callback: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

export function createDb(): DatabaseClient {
  return new PoolDatabaseClient(getPool());
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
