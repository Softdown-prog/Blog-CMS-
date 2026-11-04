import type { EditorialPost } from '../policy';

/** Contrato puro: nenhum adaptador PostgreSQL é criado nesta etapa. */
export interface EditorialRepository {
  findById(id: string): Promise<EditorialPost | null>;
  /** A criação futura persistirá post e snapshot da revisão 0 atomicamente. */
  createDraft(post: EditorialPost): Promise<'created' | 'duplicate-slug'>;
  /**
   * Implementação futura: UPDATE condicional por id e revision.
   * Gravar nova revisão e histórico na mesma transação; detectar conflito
   * mesmo quando outra escrita ocorre após findById.
   */
  compareAndSave(
    next: EditorialPost,
    expectedRevision: number,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'>;
}

export interface EditorialClock {
  nowIso(): string;
}

export interface EditorialIds {
  newId(): string;
}

