import { Inject, Injectable, OnApplicationShutdown, Provider } from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';

export const BLOG_DATABASE = 'BLOG_DATABASE';

export interface PostsDatabase {
  query<Row extends QueryResultRow>(sql: string): Promise<{ readonly rows: Row[] }>;
}

/**
 * Não cria conexões sem DATABASE_URL. Não executa migrations ou SQL de escrita.
 * Na VPS, usar database e credenciais exclusivos do CMS.
 */
export const databaseProvider: Provider = {
  provide: BLOG_DATABASE,
  useFactory: (): Pool | null => {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) return null;
    return new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      application_name: 'blog-cms-api',
    });
  },
};

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(BLOG_DATABASE) private readonly pool: Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

