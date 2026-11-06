-- PROPOSTA 004: somente PostgreSQL de teste descartável após 001 e 002.
-- Não executar na VPS sem revisão e migração de banco existente.
BEGIN;
ALTER TABLE cms_posts ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'post'
  CONSTRAINT cms_content_kind_valid CHECK (content_kind IN ('post', 'page'));
CREATE INDEX cms_public_kind_idx ON cms_posts(content_kind, published_at DESC, id DESC)
  WHERE status='published';
CREATE TABLE cms_site_widgets (
  widget_key TEXT PRIMARY KEY CHECK (widget_key IN ('latest-posts','popular-posts','page-links','text')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 100),
  content TEXT NOT NULL DEFAULT '' CHECK(length(content) <= 1000)
);
INSERT INTO cms_site_widgets(widget_key,title,enabled,position,content) VALUES
 ('latest-posts','Últimas postagens',TRUE,10,''),
 ('popular-posts','Mais populares',TRUE,20,''),
 ('page-links','Páginas e tutoriais',TRUE,30,''),
 ('text','Sobre este site',FALSE,40,'');
-- Contagem aproximada de leitores por dia, sem IP nem User-Agent em texto claro.
CREATE TABLE cms_post_views (
 post_id UUID NOT NULL REFERENCES cms_posts(id) ON DELETE CASCADE,
 view_day DATE NOT NULL,
 visitor_digest TEXT NOT NULL CHECK(visitor_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(post_id,view_day,visitor_digest)
);
CREATE INDEX cms_views_recent_idx ON cms_post_views(view_day DESC,post_id);
COMMIT;
