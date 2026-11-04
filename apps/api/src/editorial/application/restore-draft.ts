import { parseEditorialDocument } from '../document';
import type { EditorialActor, EditorialPost } from '../policy';
import type { UserRevisionOrigin } from './revision-origin';
import { isVerifiedEditorialRevision } from './revisions';

export interface RestoreRevisionRequest {
  readonly postId: unknown;
  readonly targetRevision: unknown;
  readonly expectedRevision: unknown;
}

export type RestoreError =
  | 'forbidden' | 'invalid-input' | 'not-found'
  | 'revision-not-found' | 'corrupt-revision'
  | 'stale-revision' | 'invalid-transition' | 'duplicate-slug';

export type RestoreResult =
  | Readonly<{ ok: true; value: EditorialPost }>
  | Readonly<{ ok: false; error: RestoreError }>;

/**
 * Contrato de persistência da restauração; NÃO implementado com SQL.
 * O adaptador futuro deve:
 * 1. recuperar o snapshot original imutável por (postId, revision);
 * 2. atualizar somente se status='draft' e revision=expectedRevision;
 * 3. gravar nova revisão e a origem do usuário na MESMA transação;
 * 4. desfazer TUDO caso o INSERT no histórico falhe;
 * 5. respeitar unicidade de slug, sem sobrescrever outro post.
 *
 * A leitura de histórico ocorre depois da autorização do caso de uso.
 */
export interface RestoreDraftStore {
  findById(id: string): Promise<EditorialPost | null>;
  findRevision(postId: string, revision: number): Promise<unknown | null>;
  restoreDraft(
    next: EditorialPost,
    expectedRevision: number,
    origin: UserRevisionOrigin,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Recuperar conteúdo antigo cria uma NOVA revisão, jamais regrava o histórico.
 * Preserva identidade do post/autor. Não retrocede status publicado/agendado.
 * A API futura deve fornecer actor exclusivamente de sessão autenticada.
 */
export class RestoreHistoricalDraft {
  constructor(private readonly store: RestoreDraftStore) {}

  async execute(actor: EditorialActor, input: RestoreRevisionRequest): Promise<RestoreResult> {
    if (!isUuid(actor.id) || !['author', 'editor', 'admin'].includes(actor.role)) {
      return { ok: false, error: 'forbidden' };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !isUuid(input.postId)
      || typeof input.targetRevision !== 'number'
      || !Number.isSafeInteger(input.targetRevision) || input.targetRevision < 0
      || typeof input.expectedRevision !== 'number'
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      return { ok: false, error: 'invalid-input' };
    }

    const current = await this.store.findById(input.postId);
    if (!current) return { ok: false, error: 'not-found' };

    // Autorização antes do acesso aos snapshots de versões privadas.
    if (actor.role === 'author' && current.authorId !== actor.id) {
      return { ok: false, error: 'forbidden' };
    }
    if (current.status !== 'draft') return { ok: false, error: 'invalid-transition' };

    if (!Number.isSafeInteger(current.revision) || current.revision < 1
      || current.revision >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: 'invalid-input' };
    }
    if (current.revision !== input.expectedRevision) {
      return { ok: false, error: 'stale-revision' };
    }
    if (input.targetRevision >= current.revision) {
      return { ok: false, error: 'invalid-input' };
    }

    const historical: unknown = await this.store.findRevision(current.id, input.targetRevision);
    if (historical === null) return { ok: false, error: 'revision-not-found' };
    if (!isVerifiedEditorialRevision(historical, current, input.targetRevision)) {
      return { ok: false, error: 'corrupt-revision' };
    }

    // Apenas o conteúdo editorial pode retornar. Nunca restaurar permissões,
    // autor, datas de agendamento/publicação ou estado de versão antiga.
    const snapshot = historical.snapshot;
    const next: EditorialPost = {
      ...current,
      title: snapshot.title,
      slug: snapshot.slug,
      excerpt: snapshot.excerpt,
      body: parseEditorialDocument(snapshot.body),
      revision: current.revision + 1,
      status: 'draft',
      scheduledAt: null,
      publishedAt: null,
    };
    const origin: UserRevisionOrigin = { kind: 'user', userId: actor.id };
    const outcome = await this.store.restoreDraft(next, current.revision, origin);
    if (outcome === 'conflict') return { ok: false, error: 'stale-revision' };
    if (outcome === 'duplicate-slug') return { ok: false, error: 'duplicate-slug' };
    if (outcome !== 'updated') throw new Error('RestoreDraftStore retornou estado desconhecido');
    return { ok: true, value: next };
  }
}

