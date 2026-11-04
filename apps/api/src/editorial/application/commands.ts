import { DocumentValidationError, EditorialDocumentV1, parseEditorialDocument } from '../document';
import {
  decideEditorialTransition, EditorialActor, EditorialPost, EditorialRole,
} from '../policy';
import { EditorialClock, EditorialIds, EditorialRepository } from './ports';

export type UseCaseError =
  | 'forbidden' | 'invalid-input' | 'invalid-document' | 'not-found'
  | 'stale-revision' | 'invalid-transition' | 'not-publishable'
  | 'duplicate-slug' | 'invalid-schedule';

export type UseCaseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: UseCaseError }>;

export interface DraftFields {
  readonly title: unknown;
  readonly slug: unknown;
  readonly excerpt: unknown;
  readonly body: unknown;
}

export interface SaveDraftInput extends DraftFields {
  readonly postId: string;
  readonly expectedRevision: number;
}

export interface PublishDraftInput {
  readonly postId: string;
  readonly expectedRevision: number;
}

export interface ScheduleDraftInput extends PublishDraftInput {
  readonly scheduledAt: string;
}

interface ValidatedFields {
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly body: EditorialDocumentV1;
}

function reject<T>(error: UseCaseError): UseCaseResult<T> {
  return { ok: false, error };
}

function accept<T>(value: T): UseCaseResult<T> {
  return { ok: true, value };
}

function knownRole(role: EditorialRole): boolean {
  return role === 'admin' || role === 'editor' || role === 'author';
}

function validString(value: unknown, length: number, empty: boolean): value is string {
  return typeof value === 'string' && value.length <= length
    && (empty || value.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function revisionValid(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision >= 0;
}

function parseFields(input: DraftFields): UseCaseResult<ValidatedFields> {
  if (!validString(input.title, 240, false) || !validSlug(input.slug)
      || !validString(input.excerpt, 500, true)) return reject('invalid-input');

  try {
    return accept({
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt,
      body: parseEditorialDocument(input.body),
    });
  } catch (error: unknown) {
    if (error instanceof DocumentValidationError) return reject('invalid-document');
    throw error;
  }
}

/**
 * Casos de uso: não expor como endpoints sem autenticação e RBAC.
 * Actor e suas permissões devem vir de uma sessão verificada pelo servidor.
 */
export class EditorialCommands {
  constructor(
    private readonly repo: EditorialRepository,
    private readonly clock: EditorialClock,
    private readonly ids: EditorialIds,
  ) {}

  async createDraft(actor: EditorialActor, input: DraftFields): Promise<UseCaseResult<EditorialPost>> {
    if (!knownRole(actor.role) || !validId(actor.id)) return reject('forbidden');
    const parsed = parseFields(input);
    if (!parsed.ok) return parsed;
    const id = this.ids.newId();
    if (!validId(id)) return reject('invalid-input');
    const post: EditorialPost = {
      id, authorId: actor.id, revision: 0, status: 'draft',
      ...parsed.value, scheduledAt: null, publishedAt: null,
    };
    const result = await this.repo.createDraft(post);
    return result === 'created' ? accept(post) : reject('duplicate-slug');
  }

  async saveDraft(actor: EditorialActor, input: SaveDraftInput): Promise<UseCaseResult<EditorialPost>> {
    if (!knownRole(actor.role) || !validId(actor.id)) return reject('forbidden');
    if (!validId(input.postId) || !revisionValid(input.expectedRevision)) return reject('invalid-input');

    const current = await this.repo.findById(input.postId);
    if (!current) return reject('not-found');
    // Publicados e agendados não podem ser alterados pelo fluxo de rascunhos.
    if (current.status !== 'draft') return reject('invalid-transition');

    const decision = decideEditorialTransition(
      actor, current, { operation: 'edit', expectedRevision: input.expectedRevision },
      this.clock.nowIso(),
    );
    if (!decision.ok) return reject(decision.reason);

    const parsed = parseFields(input);
    if (!parsed.ok) return parsed;

    const next: EditorialPost = { ...current, ...parsed.value, revision: current.revision + 1 };
    const outcome = await this.repo.compareAndSave(next, input.expectedRevision);
    if (outcome === 'duplicate-slug') return reject('duplicate-slug');
    return outcome === 'updated' ? accept(next) : reject('stale-revision');
  }

  async publishDraft(
    actor: EditorialActor,
    input: PublishDraftInput,
  ): Promise<UseCaseResult<EditorialPost>> {
    if (!knownRole(actor.role) || !validId(actor.id)) return reject('forbidden');
    if (!validId(input.postId) || !revisionValid(input.expectedRevision)) return reject('invalid-input');

    const current = await this.repo.findById(input.postId);
    if (!current) return reject('not-found');
    if (current.status !== 'draft') return reject('invalid-transition');

    const decision = decideEditorialTransition(
      actor, current, { operation: 'publish', expectedRevision: input.expectedRevision },
      this.clock.nowIso(),
    );
    if (!decision.ok) return reject(decision.reason);

    const next: EditorialPost = {
      ...current, status: decision.nextStatus,
      scheduledAt: decision.nextScheduledAt,
      publishedAt: decision.nextPublishedAt,
      revision: current.revision + 1,
    };
    const outcome = await this.repo.compareAndSave(next, input.expectedRevision);
    return outcome === 'updated' ? accept(next)
      : reject(outcome === 'duplicate-slug' ? 'duplicate-slug' : 'stale-revision');
  }

  /**
   * Enfileira a intenção editorial: scheduled NÃO torna um post público.
   * Um publicador futuro, separado, terá de revalidar a data e fazer a
   * transição transacional para published. Sem timers ou jobs nesta fase.
   */
  async scheduleDraft(
    actor: EditorialActor, input: ScheduleDraftInput,
  ): Promise<UseCaseResult<EditorialPost>> {
    if (!knownRole(actor.role) || !validId(actor.id)) return reject('forbidden');
    if (!validId(input.postId) || !revisionValid(input.expectedRevision)) return reject('invalid-input');
    const current = await this.repo.findById(input.postId);
    if (!current) return reject('not-found');
    if (current.status !== 'draft' && current.status !== 'scheduled') return reject('invalid-transition');

    const decision = decideEditorialTransition(
      actor, current, {
        operation: 'schedule',
        expectedRevision: input.expectedRevision,
        scheduledAt: input.scheduledAt,
      },
      this.clock.nowIso(),
    );
    if (!decision.ok) return reject(decision.reason);
    const next: EditorialPost = {
      ...current, status: decision.nextStatus,
      scheduledAt: decision.nextScheduledAt,
      publishedAt: decision.nextPublishedAt,
      revision: current.revision + 1,
    };
    const outcome = await this.repo.compareAndSave(next, input.expectedRevision);
    return outcome === 'updated' ? accept(next)
      : reject(outcome === 'duplicate-slug' ? 'duplicate-slug' : 'stale-revision');
  }

  /** Cancela um agendamento com CAS e volta a rascunho, nunca publica. */
  async cancelSchedule(
    actor: EditorialActor, input: PublishDraftInput,
  ): Promise<UseCaseResult<EditorialPost>> {
    if (!knownRole(actor.role) || !validId(actor.id)) return reject('forbidden');
    if (!validId(input.postId) || !revisionValid(input.expectedRevision)) return reject('invalid-input');
    const current = await this.repo.findById(input.postId);
    if (!current) return reject('not-found');
    if (current.status !== 'scheduled') return reject('invalid-transition');

    const decision = decideEditorialTransition(
      actor, current, { operation: 'unschedule', expectedRevision: input.expectedRevision },
      this.clock.nowIso(),
    );
    if (!decision.ok) return reject(decision.reason);
    const next: EditorialPost = {
      ...current, status: decision.nextStatus,
      scheduledAt: decision.nextScheduledAt,
      publishedAt: decision.nextPublishedAt,
      revision: current.revision + 1,
    };
    const outcome = await this.repo.compareAndSave(next, input.expectedRevision);
    return outcome === 'updated' ? accept(next)
      : reject(outcome === 'duplicate-slug' ? 'duplicate-slug' : 'stale-revision');
  }
}
