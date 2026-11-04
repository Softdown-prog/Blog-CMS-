-- PROPOSTA ARQUITETURAL: NÃO EXECUTAR NA VPS OU EM BANCO POVOADO.
-- Somente após 001_initial.sql em banco NOVO e descartável; revisão pendente.
-- Proposta fora de database/migrations para impedir aplicação acidental.
BEGIN;

-- CAS editorial em banco: revisão começa em zero no rascunho.
ALTER TABLE cms_posts
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT cms_posts_revision_nonnegative CHECK (revision >= 0);

-- Separação DEFINITIVA da data agendada e da publicação efetiva.
ALTER TABLE cms_posts
  ADD COLUMN scheduled_at TIMESTAMPTZ;

ALTER TABLE cms_posts ADD CONSTRAINT cms_posts_dates_by_status CHECK (
    (status = 'scheduled' AND scheduled_at IS NOT NULL AND published_at IS NULL)
 OR (status = 'published' AND scheduled_at IS NULL AND published_at IS NOT NULL)
 OR (status = 'draft' AND scheduled_at IS NULL AND published_at IS NULL)
 OR (status = 'archived' AND scheduled_at IS NULL)
);

-- Paginação editorial por keyset e escopo de autor.
CREATE INDEX cms_posts_admin_seek_idx
  ON cms_posts (created_at DESC, id DESC);
CREATE INDEX cms_posts_author_status_seek_idx
  ON cms_posts (author_id, status, created_at DESC, id DESC);
CREATE INDEX cms_posts_status_seek_idx
  ON cms_posts (status, created_at DESC, id DESC);

-- Fila lógica somente leitura: sem cron, sem triggers, sem envio externo.
CREATE INDEX cms_posts_due_idx
  ON cms_posts (scheduled_at ASC, id ASC)
  WHERE status = 'scheduled';

-- HISTÓRICO COMPLETO: proposta válida apenas se 001 ainda não recebeu dados.
-- Snapshot de EditorialPost (inclui scheduledAt separado de publishedAt).
ALTER TABLE cms_post_revisions
  RENAME COLUMN body TO snapshot;
ALTER TABLE cms_post_revisions
  ADD COLUMN revision BIGINT NOT NULL
    CONSTRAINT cms_revisions_revision_nonnegative CHECK (revision >= 0);

-- Auditoria por discriminação: humanos com FK, serviço SEM usuário fictício.
ALTER TABLE cms_post_revisions
  ALTER COLUMN editor_id DROP NOT NULL;
ALTER TABLE cms_post_revisions
  ADD COLUMN origin_kind TEXT NOT NULL
    CONSTRAINT cms_revisions_origin_kind CHECK (origin_kind IN ('user','system'));
ALTER TABLE cms_post_revisions
  ADD COLUMN system_key TEXT;

ALTER TABLE cms_post_revisions
  ADD CONSTRAINT cms_revisions_origin_consistency CHECK (
    (origin_kind = 'user' AND editor_id IS NOT NULL AND system_key IS NULL)
    OR
    (origin_kind = 'system' AND editor_id IS NULL AND system_key = 'scheduled-publisher')
  );

ALTER TABLE cms_post_revisions
  ADD CONSTRAINT cms_revisions_unique_post_version UNIQUE (post_id, revision);
CREATE INDEX cms_revisions_history_idx
  ON cms_post_revisions (post_id, revision DESC);

-- Persistência futura: INSERT/UPDATE com CAS, INSERT de revisão e COMMIT único.
-- Uma publicação agendada deve validar status=scheduled, revision igual ao
-- candidato, scheduled_at igual ao candidato e scheduled_at <= NOW().
-- O UPDATE deve zerar scheduled_at e definir published_at a instante efetivo
-- sem preservar erroneamente data de planejamento como publicação.
-- O registro de revisão do evento usa origin_kind='system',
-- editor_id=NULL e system_key='scheduled-publisher'.
-- Notificações futuras somente por outbox transacional idempotente.

COMMIT;
