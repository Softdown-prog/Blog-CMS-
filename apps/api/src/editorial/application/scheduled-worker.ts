import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { BLOG_DATABASE } from '../../database';
import { PgScheduledPublicationStore } from './postgres-scheduled';
import { ScheduledPublicationDispatcher, type DispatchResult } from './scheduled-dispatcher';

/**
 * NestJS in-process publisher. The schedule lives in PostgreSQL, not memory:
 * restarting the API does not lose scheduled posts. A second instance is safe
 * because the adapter uses transactional conditional UPDATE.
 */
@Injectable()
export class ScheduledPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ScheduledPublisherWorker.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopping = false;

  constructor(@Inject(BLOG_DATABASE) private readonly pool: Pool | null) {}

  async runOnce(limit = 25): Promise<DispatchResult> {
    if (!this.pool) throw new Error('PostgreSQL indisponível para agendamento.');
    return new ScheduledPublicationDispatcher(
      new PgScheduledPublicationStore(this.pool),
      { nowIso: () => new Date().toISOString() },
    ).runOnce(limit);
  }

  onApplicationBootstrap(): void {
    if (!this.pool) return;
    this.stopping = false;
    // A polling cadence avoids timers per post and catches up after downtime.
    this.interval = setInterval(() => { void this.tick(); }, 30_000);
    this.interval.unref();
    void this.tick();
  }

  private async processDue(): Promise<void> {
    // Bounded catch-up: at most 250 due posts per tick. Remaining posts wait
    // for the next tick; transient DB errors retry naturally on the next tick.
    for (let batch = 0; batch < 10 && !this.stopping; batch++) {
      const result = await this.runOnce(25);
      if (!result.ok) throw new Error('Despachante retornou: ' + result.error);
      if (result.published > 0) {
        this.logger.log('Publicações agendadas efetivadas: ' + result.published);
      }
      if (result.selected < 25 || result.published === 0) break;
    }
  }

  private tick(): Promise<void> {
    if (!this.pool || this.stopping) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = this.processDue().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      this.logger.error('Falha na publicação agendada: ' + message);
    });
    this.pending = work;
    void work.finally(() => { if (this.pending === work) this.pending = null; });
    return work;
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.pending;
  }
}
