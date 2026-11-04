-- Schema inicial do Blog CMS. Aplicar somente em banco exclusivo, após revisão.
BEGIN;
CREATE TABLE cms_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('admin','editor','author')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE cms_posts (
  id UUID PRIMARY KEY,
  author_id UUID NOT NULL REFERENCES cms_users(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  excerpt TEXT NOT NULL DEFAULT '',
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX cms_posts_public_idx ON cms_posts (published_at DESC)
  WHERE status = 'published';
CREATE TABLE cms_categories (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
CREATE TABLE cms_post_categories (
  post_id UUID NOT NULL REFERENCES cms_posts(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES cms_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, category_id)
);
CREATE TABLE cms_media (
  id UUID PRIMARY KEY,
  uploader_id UUID NOT NULL REFERENCES cms_users(id),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE cms_post_revisions (
  id UUID PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES cms_posts(id) ON DELETE CASCADE,
  editor_id UUID NOT NULL REFERENCES cms_users(id),
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;

