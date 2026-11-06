-- Proposta 005: executar exclusivamente em banco descartavel ate homologacao.
-- Depende da 004. Nao aplicar automaticamente na VPS.
BEGIN;
ALTER TABLE cms_site_widgets DROP CONSTRAINT cms_site_widgets_widget_key_check;
ALTER TABLE cms_site_widgets ADD CONSTRAINT cms_site_widgets_widget_key_check
  CHECK (widget_key IN ('latest-posts','popular-posts','page-links','text','buttons'));
INSERT INTO cms_site_widgets(widget_key,title,enabled,position,content)
VALUES ('buttons','Links úteis',FALSE,50,'')
ON CONFLICT(widget_key) DO NOTHING;

CREATE TABLE cms_widget_buttons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  hover_text TEXT NOT NULL DEFAULT '' CHECK (char_length(hover_text) <= 160),
  href TEXT NOT NULL CHECK (char_length(href) BETWEEN 1 AND 500),
  position INTEGER NOT NULL DEFAULT 50 CHECK (position BETWEEN 0 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX cms_widget_buttons_display_idx ON cms_widget_buttons(position,id)
  WHERE enabled=TRUE;
COMMIT;
