import { DocumentValidationError, hasPublishableContent, parseEditorialDocument } from './document';

export type EditorialRole = 'admin' | 'editor' | 'author';
export type EditorialStatus = 'draft' | 'scheduled' | 'published' | 'archived';
export type EditorialOperation = 'edit' | 'schedule' | 'unschedule' | 'publish' | 'archive' | 'restore';

export interface EditorialActor {
  readonly id: string;
  readonly role: EditorialRole;
}

export interface EditorialPost {
  readonly id: string;
  readonly authorId: string;
  readonly revision: number;
  readonly status: EditorialStatus;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly body: unknown;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
}

export interface EditorialCommand {
  readonly operation: EditorialOperation;
  readonly expectedRevision: number;
  readonly scheduledAt?: string;
}

export type DecisionError =
  | 'forbidden' | 'stale-revision' | 'invalid-transition'
  | 'invalid-schedule' | 'not-publishable';

export type EditorialDecision =
  | Readonly<{ ok: true; nextStatus: EditorialStatus; nextScheduledAt: string | null; nextPublishedAt: string | null }>
  | Readonly<{ ok: false; reason: DecisionError }>;

const transitions: Readonly<Record<EditorialStatus, readonly EditorialOperation[]>> = {
  draft: ['edit', 'schedule', 'publish', 'archive'],
  scheduled: ['edit', 'schedule', 'unschedule', 'publish', 'archive'],
  published: ['edit', 'archive'],
  archived: ['restore'],
};

function failure(reason: DecisionError): EditorialDecision {
  return { ok: false, reason };
}

/** Somente timestamps ISO UTC canônicos; relógio é injetado pelo caller. */
function instant(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function publishable(post: EditorialPost): boolean {
  if (post.title.trim().length === 0 || post.title.length > 240
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) || post.slug.length > 100
    || post.excerpt.length > 500) return false;
  try {
    return hasPublishableContent(parseEditorialDocument(post.body));
  } catch (error: unknown) {
    if (error instanceof DocumentValidationError) return false;
    throw error;
  }
}

/**
 * Regra de negócio pura: não faz login, não consulta banco, não incrementa revisão.
 * O serviço transacional futuro fará autorização novamente, aplicará a alteração
 * com WHERE revision = expectedRevision e persistirá a revisão no mesmo commit.
 */
export function decideEditorialTransition(
  actor: EditorialActor,
  post: EditorialPost,
  command: EditorialCommand,
  nowIso: string,
): EditorialDecision {
  // Nunca confiar no Angular como fronteira de permissão.
  const isManager = actor.role === 'admin' || actor.role === 'editor';
  const ownsDraft = actor.role === 'author' && actor.id === post.authorId && post.status === 'draft';
  const authorAllowed = ownsDraft && (command.operation === 'edit' || command.operation === 'archive');
  if (!isManager && !authorAllowed) return failure('forbidden');

  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0
    || post.revision !== command.expectedRevision) return failure('stale-revision');
  if (!transitions[post.status].includes(command.operation)) return failure('invalid-transition');
  const now = instant(nowIso);
  if (now === null) return failure('invalid-schedule');

  if (command.operation === 'edit') {
    return { ok: true, nextStatus: post.status, nextScheduledAt: post.scheduledAt, nextPublishedAt: post.publishedAt };
  }
  if (command.operation === 'schedule') {
    const at = instant(command.scheduledAt);
    if (at === null || at <= now) return failure('invalid-schedule');
    if (!publishable(post)) return failure('not-publishable');
    return { ok: true, nextStatus: 'scheduled', nextScheduledAt: command.scheduledAt ?? null, nextPublishedAt: null };
  }
  if (command.operation === 'publish') {
    if (!publishable(post)) return failure('not-publishable');
    return { ok: true, nextStatus: 'published', nextScheduledAt: null, nextPublishedAt: nowIso };
  }
  if (command.operation === 'archive') {
    return { ok: true, nextStatus: 'archived', nextScheduledAt: null, nextPublishedAt: post.publishedAt };
  }
  // Cancelar agendamento ou restaurar do arquivo exige reedição/revisão antes de publicar.
  return { ok: true, nextStatus: 'draft', nextScheduledAt: null, nextPublishedAt: null };
}
