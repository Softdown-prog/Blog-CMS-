# Histórico e recuperação de versões — editor Blog CMS

Esta etapa liga os contratos de domínio já existentes
`ListEditorialRevisions` e `RestoreHistoricalDraft` ao PostgreSQL
e ao painel Angular autenticado. **Não modifica o banco nem cria migrações.**

## Fluxo

1. O autor acessa seu rascunho em `/admin?draft=<uuid>`.
2. Clica em **Consultar histórico** e seleciona uma revisão salva.
3. O painel apresenta título, endereço, resumo e corpo como **texto literal**.
4. Se não houver alterações locais pendentes, escolhe **Recuperar esta versão**.
5. Após confirmação, a API cria uma **nova revisão**, sem apagar ou modificar
   nenhuma versão antiga. O usuário pode recarregar e continuar o rascunho.

O histórico é paginado por número da revisão, 10 por página no painel
(contrato suporta 1–20). A recuperação é permitida **somente para rascunhos**,
exige revisão esperada e não retrocede permissões, dono, datas
de publicação ou estado de conteúdos publicados. O tipo `post/page`
é mantido. O conteúdo da revisão antiga pode ser inspecionado
antes de restaurar.

## Endpoints

- `GET /api/admin/editorial/drafts/:id/revisions?limit=10&beforeRevision=N`:
  leitura privada, sem cache, paginação decrescente. Retorna
  `{items:[{revision,recordedAt,origin,snapshot}],nextBeforeRevision}`.
  Só o autor do rascunho, editor ou administrador pode consultar.
- `POST /api/admin/editorial/drafts/:id/restore`:
  recebe somente `{targetRevision,expectedRevision}`; exige sessão
  HttpOnly, `Origin` canônica, `X-CMS-CSRF`, RBAC e CAS. Retorna
  a nova revisão persistida.

Nenhum ator, role ou conteúdo é aceito pelo body da restauração.
O servidor recupera os snapshots históricos; não confia em cópias
enviadas pelo navegador. Valores inválidos geram 400, conteúdo não
encontrado 404, concorrência/slug repetido 409 e falha de integridade
503 sem expor SQL.

## Persistência e segurança

`PgEditorialHistoryStore` consulta `cms_post_revisions` e aplica
os validadores completos do domínio, incluindo integridade de schema
e proveniência dos registros. Na restauração, a transação atualiza
`cms_posts` condicionada a `id`, `author_id`, `status='draft'`
e `revision` esperada, e grava a nova linha do histórico antes de
`COMMIT`. Erro na gravação da revisão implica rollback completo.
Não há sobrescrita silenciosa de outra sessão.

A leitura não é disponibilizada publicamente. O Angular interpola
os blocos sem `innerHTML`, e não persiste histórico em
`localStorage`. O painel exige que mudanças locais sejam salvas
ou descartadas antes de recuperar uma versão anterior.

## Validação

- Teste HTTP + PostgreSQL 18 descartável: sessão real, CSRF/Origin,
  paginação, origem do histórico, restauração, CAS, preservação dos
  snapshots anteriores e rollback ao falhar o INSERT.
- Playwright desktop/mobile: seleção/preview, HTML literal escapado,
  confirmação explícita, recarregar nova revisão, alteração local
  pendente e erro HTTP 409.
- Reutiliza os testes unitários de domínio da listagem e restauração.
- Nenhuma migração foi executada na VPS; CI é validação de código,
  não homologação de ambiente de produção.
