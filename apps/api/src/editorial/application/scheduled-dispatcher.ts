import type { EditorialClock } from './ports';
import { SCHEDULED_PUBLISHER_ORIGIN, SystemRevisionOrigin } from './revision-origin';

/** Snapshot mínimo para seleção; nunca enviar corpo editorial ao dispatcher. */
export interface DuePublication {
  readonly id: string;
  readonly revision: number;
  /** Hora agendada em ISO UTC; corresponde exclusivamente a scheduledAt. */
  readonly dueAt: string;
}

/**
 * Contrato obrigatório do adaptador futuro:
 * - listDue filtra status=scheduled e data <= nowIso e ordena dueAt ASC, id ASC.
 * - publishIfDue faz CAS em UMA transação: status scheduled, mesma revision,
 *   mesma dueAt e dueAt <= nowIso, com atualização para published, revision+1
 *   e snapshot de revisão na mesma transação.
 * - 'skipped' significa perda da disputa, cancelamento ou reagendamento.
 * - Garantia contra publicação duplicada vem do banco, NÃO desta classe.
 * - Não chamar efeitos externos (webhooks/emails) dentro da transação.
 */
export interface ScheduledPublicationStore {
  listDue(nowIso: string, limit: number): Promise<readonly DuePublication[]>;
  publishIfDue(candidate: DuePublication, nowIso: string, origin: SystemRevisionOrigin): Promise<'published' | 'skipped'>;
}

export type DispatchResult =
  | Readonly<{ ok: true; selected: number; published: number; skipped: number }>
  | Readonly<{ ok: false; error: 'invalid-time' | 'repository-contract-violation' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Restringir a timestamps UTC canônicos para não misturar timezones. */
function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validCandidates(rows: readonly DuePublication[], nowIso: string, limit: number): boolean {
  if (rows.length > limit) return false;
  const now = utcMillis(nowIso);
  if (now === null) return false;
  const seen = new Set<string>();
  let previous: DuePublication | null = null;
  for (const item of rows) {
    if (!item || typeof item !== 'object'
      || Object.keys(item).length !== 3
      || !['id', 'revision', 'dueAt'].every(key => Object.hasOwn(item, key))
      || typeof item.id !== 'string' || !UUID.test(item.id)
      || !Number.isSafeInteger(item.revision) || item.revision < 0
      || utcMillis(item.dueAt) === null || item.dueAt > nowIso
      || seen.has(item.id)) return false;
    if (previous !== null && (previous.dueAt > item.dueAt
      || (previous.dueAt === item.dueAt && previous.id >= item.id))) return false;
    previous = item;
    seen.add(item.id);
  }
  return true;
}

/**
 * Orquestração offline. Sem timer, cron, endpoint, NestJS, banco ou integração.
 * Erros inesperados de persistência são propagados, jamais registrados como
 * sucesso. Rodar de novo é seguro somente se o adapter cumprir CAS transacional.
 */
export class ScheduledPublicationDispatcher {
  constructor(
    private readonly store: ScheduledPublicationStore,
    private readonly clock: EditorialClock,
  ) {}

  async runOnce(limit = 25): Promise<DispatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return { ok: false, error: 'repository-contract-violation' };
    }
    const nowIso = this.clock.nowIso();
    if (utcMillis(nowIso) === null) return { ok: false, error: 'invalid-time' };
    const rows = await this.store.listDue(nowIso, limit);
    if (!Array.isArray(rows) || !validCandidates(rows, nowIso, limit)) {
      return { ok: false, error: 'repository-contract-violation' };
    }

    let published = 0;
    let skipped = 0;
    // Sequencial e limitado; a concorrência real entre runners depende de CAS.
    for (const candidate of rows) {
      const result = await this.store.publishIfDue(candidate, nowIso, SCHEDULED_PUBLISHER_ORIGIN);
      if (result === 'published') published++;
      else if (result === 'skipped') skipped++;
      else throw new Error('ScheduledPublicationStore retornou um estado desconhecido');
    }
    return { ok: true, selected: rows.length, published, skipped };
  }
}
