-- PROPOSTA DE MODELO, NÃO É MIGRAÇÃO APROVADA PARA EXECUÇÃO.
-- NÃO executar na VPS. Válida SOMENTE após a 001 em BANCO VAZIO descartável.
-- Dados preexistentes exigem estratégia de backfill, validação e revisão manual.
-- Este arquivo NÃO está no diretório database/migrations e NÃO é usado por CI.
BEGIN;

-- Representar o compare-and-swap de comandos editoriais com revisão versionada.
ALTER TABLE cms_posts
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT cms_posts_revision_nonnegative CHECK (revision >= 0);

-- Nesta fase, published_at de status='scheduled' representa o prazo.
-- É uma dívida técnica documentada; antes da integração real, decidir se
-- adicionaremos scheduled_at separado e migraremos a política/DTOs.
CREATE INDEX cms_posts_admin_seek_idx
  ON cms_posts (created_at DESC, id DESC);

CREATE INDEX cms_posts_author_status_seek_idx
  ON cms_posts (author_id, status, created_at DESC, id DESC);

CREATE INDEX cms_posts_status_seek_idx
  ON cms_posts (status, created_at DESC, id DESC);

CREATE INDEX cms_posts_due_idx
  ON cms_posts (published_at ASC, id ASC)
  WHERE status = 'scheduled';

-- Somente banco novo: a antiga coluna 'body' de revisões não tem histórico
-- existente. Renomear para armazenar o SNAPSHOT COMPLETO do EditorialPost v1.
-- NÃO aplicar a uma base povoada; dados antigos não possuem revision completo.
ALTER TABLE cms_post_revisions
  RENAME COLUMN body TO snapshot;

ALTER TABLE cms_post_revisions
  ADD COLUMN revision BIGINT NOT NULL
    CONSTRAINT cms_revisions_revision_nonnegative CHECK (revision >= 0);

ALTER TABLE cms_post_revisions
  ADD CONSTRAINT cms_revisions_unique_post_version UNIQUE (post_id, revision);

CREATE INDEX cms_revisions_history_idx
  ON cms_post_revisions (post_id, revision DESC);

-- Adaptador SQL (futuro) deve transacionar:
-- 1) UPDATE cms_posts WHERE id=$id AND revision=$old_revision
--      AND status/horário esperado; RETURNING ... (0 linhas => skipped);
-- 2) INSERT cms_post_revisions ... snapshot completo, revision=$old+1;
-- 3) COMMIT. Em erro, ROLLBACK. Não adicionar callbacks externos aqui.
-- EditorialPost da aplicação continua armazenando scheduled at em publishedAt
-- temporariamente. Snapshot precisa ser JSONB compatível com Document v1.
-- Registro automático requer definir uma identidade de serviço auditável
-- para cms_post_revisions.editor_id (FK obrigatória), SEM login interativo.
COMMIT;
