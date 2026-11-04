# Datas editoriais e origem de auditoria — design v2

## Situação
O CMS permanece sem integração a banco real, worker, cron, API administrativa,
PR, merge e deploy. O rascunho SQL foi atualizado em
`database/proposals/002_editorial_storage_draft.sql` (não é migration executável).

## Datas agora distintas no domínio TypeScript
- `scheduledAt: string | null`: instante futuro escolhido pelo editor para
  o artigo **scheduled**. Este valor não é a hora em que foi publicado.
- `publishedAt: string | null`: instante em que o conteúdo se tornou de fato
  **published**. Só deve ser marcado na transição de publicação efetiva.
- Rascunho: ambos nulos. Agendado: somente scheduledAt preenchido.
  Publicado: somente publishedAt preenchido. Arquivado: pode reter publishedAt
  histórico, mas nunca scheduledAt ativo.
- Agendamento, reagendamento, cancelamento e publicação usam as duas datas
  corretamente. O dispatcher passa um candidato `dueAt` como snapshot de
  `scheduledAt`; o adaptador futuro fará o CAS na coluna `scheduled_at`.
- Sem scheduler real: o dispatcher continua somente um caso de uso testado
  com portas falsas.

## Proveniência humana versus sistema
O histórico deixa de exigir um `editedBy` de usuário em todas as revisões.
Agora cada `EditorialRevision` contém `origin`:

```ts
{ kind: 'user', userId: '<UUID do editor autenticado>' }
{ kind: 'system', service: 'scheduled-publisher' }
```

A origem de usuário deve vir do servidor após autenticação; jamais de um campo
do cliente. A origem de sistema é constante do código da aplicação, não uma
conta de usuário nem um token secreto. Só a camada de processamento autorizada
deve chamar a porta de publicação agendada.

A proposta SQL define `origin_kind`, `editor_id` (FK nullable), e
`system_key` com constraint de consistência:
- usuário: `editor_id` obrigatório, `system_key` nulo;
- sistema: `editor_id` nulo e `system_key=scheduled-publisher`.

Não cria usuário fictício para os workers. A revisão da publicação automática
deve ser gravada na **mesma transação** do UPDATE do artigo; o snapshot completo
não deve conter segredo de sessão, token de autenticação ou IP.

## Pré-requisitos antes da integração
1. Provar constraints, índices e concorrência em PostgreSQL descartável.
2. Definir e implementar transactions/rollback, CAS, escrita de revisão 0,
   histórico imutável e serviço de publicação confiável.
3. Incluir testes que tentam publicar o mesmo item por duas conexões reais.
4. Resolver sessões/autorização do NestJS, sem endpoint expor origem sistêmica.
5. Implementar e testar SSR/SEO, editor, acessibilidade e Guardian/Chromium.
6. Fixar lockfiles e eliminar bootstrap npm não reprodutível em CI.

O Data_libray/SAC continua pre/build/post estático, mas não prova que transação
funciona e não autoriza deploy.
