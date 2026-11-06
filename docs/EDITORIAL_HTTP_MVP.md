# Fluxo editorial HTTP — primeiro MVP utilizável

## Implementação

O editor Angular existente, não uma nova aplicação, foi ligado aos contratos
de domínio já testados em `EditorialCommands` e ao adaptador
`PgEditorialRepository` transacional.

Rotas NestJS sob `/api/admin/editorial`:

| Método | Rota | Permissões | Comportamento |
| --- | --- | --- | --- |
| GET | `/drafts` | Sessão ativa | Até 50 rascunhos; autor apenas seus |
| GET | `/drafts/:id` | Sessão + autor ou editor/admin | Recupera JSONB e revisão atual |
| POST | `/drafts` | Sessão + CSRF + Origin | Cria rascunho, kind `post`/`page`, revisão 0 |
| PATCH | `/drafts/:id` | Sessão + CSRF + Origin | Salva se `expectedRevision` coincide |
| POST | `/drafts/:id/publish` | Editor/admin, CSRF + Origin | Publica e cria revisão transacional |

Não confiar em `actorId`, `authorId` ou `role` do body. Só a sessão
validada pelo servidor determina identidade e privilégios. Entradas aceitas
são estritas; campos inesperados geram 400, slug duplicado e revisão
defasada 409, dados não publicáveis 422, acesso indevido 403/404 e banco
indisponível 503 sem vazar SQL/credenciais.

O tipo de conteúdo é armazenado em `cms_posts.content_kind`, usando a
proposta de schema 004. Páginas fixas são publicadas em `/pages/:slug`,
postagens em `/posts/:slug`; ambas usam o mesmo documento editorial v1.

## Fluxo no Angular

1. Entrar em `/login` com conta previamente provisionada.
2. Em `/admin`, selecionar postagem ou página, editar título/slug/resumo/blocos.
3. Clicar **Salvar rascunho**. O servidor retorna ID e revisão.
4. A URL recebe `?draft=<id>` e permite recarregar sem perder o texto salvo.
   Alternativamente usar **Meus rascunhos** para localizar e reabrir.
5. Editar e clicar **Salvar alterações**; o servidor exige a revisão atual.
6. Editor/admin publica apenas a versão previamente salva e recebe link público.

Autossalvamento não foi ativado para não gravar dados involuntariamente.
Mudanças locais não salvas não substituem a versão persistida. Em conflito,
o usuário recebe orientação para reabrir a versão atual; não há sobrescrita.
Tokens de sessão nunca vão para `localStorage` ou `sessionStorage`.

**Limitação deliberada:** a biblioteca de mídias, categorias, tags e
capas ainda é demonstrativa e não faz parte da persistência do MVP;
blocos de imagem do catálogo demonstrativo são bloqueados no botão Salvar.
Upload real exige validação e autorização próprias antes de habilitação.

## Verificações

- CI NestJS: TS build e testes unitários de contratos de autorização.
- PostgreSQL 18 descartável: migrations 001 + propostas 002, 004 e 003
  (esta última no teste de login) aplicadas apenas na CI; operações reais,
  revisão 0, concorrência CAS, auditoria transacional, RBAC e publicação.
- HTTP real NestJS: login, CSRF, autorização, GET de rascunho, alterações,
  409 e publicação; não apenas testes de funções isoladas.
- Playwright Chromium desktop e mobile: criar/salvar/recarregar, erro de
  conflito, publicação e bloqueio de imagens demonstrativas, API simulada
  apenas na parte de navegador.

**NÃO aplicar essas propostas SQL automaticamente na VPS nem publicar o
CMS sem revisão da migração do banco existente, proxy Caddy, cabeçalhos de
segurança e provisionamento seguro da primeira conta.**
