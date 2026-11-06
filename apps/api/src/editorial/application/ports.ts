import type { EditorialPost } from '../policy';

/** Contrato puro: existe adaptador PostgreSQL, ainda não registrado na API. */
export interface EditorialRepository {
  findById(id: string): Promise<EditorialPost | null>;
  /** Post e snapshot da revisão 0 são gravados atomicamente pelo adaptador PG. */
  createDraft(post: EditorialPost, kind?: 'post' | 'page'): Promise<'created' | 'duplicate-slug'>;
  /**
   * UPDATE condicional por id + revision; snapshot e alteração precisam
   * participar da mesma transação, inclusive sob concorrência real.
   */
  compareAndSave(
    next: EditorialPost,
    expectedRevision: number,
    /** Identidade do ator validado pelo caso de uso, para auditoria de edição. */
    editorId: string,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'>;
}

export interface EditorialClock {
  nowIso(): string;
}

export interface EditorialIds {
  newId(): string;
}

