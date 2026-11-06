# Páginas, postagens e widgets nativos — Blog CMS

## Objetivo e estado real

Esta etapa adiciona a **separação de conteúdo público** e configurações
administrativas protegidas. **Não habilita criação/publicação pelo navegador**:
o editor Angular ainda é um laboratório offline e precisa ser conectado ao
fluxo autorizado de salvar/publicar. Nenhuma migração foi executada na VPS.

## Tipos de conteúdo

- **Postagem** (`content_kind=post`): aparece no feed cronológico em
  `/`, nos widgets de últimas e de populares, e no detalhe `/posts/:slug`.
- **Página fixa/instrucional** (`content_kind=page`): aparece em
  `/pages`, `/pages/:slug` e nos atalhos de páginas. Nunca entra no
  feed cronológico nem no ranking de postagens.
- O banco reaproveita `cms_posts` e o mesmo JSONB editorial validado;
  `content_kind` é uma coluna com `DEFAULT 'post'` para compatibilidade
  com os registros existentes.
- A configuração `/admin/site` permite classificar SOMENTE rascunhos,
  com sessão e função de administrador; publicações existentes não podem
  ser convertidas acidentalmente por essa ação.

## Widgets e gadgets permitidos

| Chave | Comportamento |
| --- | --- |
| `latest-posts` | Cinco postagens publicadas mais recentes |
| `popular-posts` | Cinco postagens com mais leituras únicas estimadas nos últimos 30 dias |
| `page-links` | Atalhos para até oito páginas publicadas |
| `text` | Gadget de texto puro, sem HTML/JS |

A tabela `cms_site_widgets` persiste posição (0–100), título, visibilidade
e texto (até 1000 caracteres). O administrador pode alterar esses campos
por `PATCH /api/admin/site/widgets/:key`, com sessão, CSRF e Origin. As
chaves são fixas, não são plugins arbitrários. O Angular só interpola texto.
O widget de popularidade fica oculto até haver leituras reais registradas;
não usamos data da publicação ou números inventados como popularidade.

## Métricas e privacidade

`POST /api/public/posts/:slug/view` registra uma impressão por postagem,
dia e impressão pseudônima de rede/User-Agent (HMAC-SHA256 com chave do
servidor). A base recebe apenas data, ID do post e digest. O IP e
User-Agent não são armazenados em texto aberto. Requisição fora da origem
canônica é ignorada; jamais confiar em `X-Forwarded-For` arbitrário.
Exige `CMS_VIEWS_HMAC_SECRET` com pelo menos 32 bytes, independente do
segredo de autenticação. **Sem esse segredo, registro de vistas fica
desativado**, e widget popular não inventa dados.

Estas são **estimativas**, não leitores humanos únicos: redes compartilhadas
e crawlers afetam a precisão. Antes de produção são necessárias política de
retenção/expurgo de 30 dias, revisão LGPD, prevenção adicional de fraude e
integração confiável com Caddy para obter endereço de origem. Configuração
ainda NÃO homologada; não usar essas métricas para faturamento.

## Banco e validação

A proposta `database/proposals/004_pages_widgets_draft.sql` é testada
SOMENTE em PostgreSQL 18 descartável da CI, após 001 e 002. A etapa de
login 003 é aplicada separadamente no teste de autenticação. Banco de
produção precisa de plano de alteração versionada, com rollback, índices
e revisão de permissões antes de receber 004. Não aplicar na VPS.

Testes: contratos em `site-content.spec.ts`, integração SQL de consulta,
reclassificação de rascunhos, persistência de widgets e deduplicação de
impressões no `site-content.integration.spec.ts`, além de Playwright
desktop/mobile para navegação, HTML escapado e opções administrativas.

## Próxima ligação realmente necessária

Conectar a criação/edição/autorização do editor ao PostgreSQL para que
o autor possa escolher tipo de conteúdo ao salvar um rascunho e um
editor/admin publique postagens e páginas com transação e revisão.
