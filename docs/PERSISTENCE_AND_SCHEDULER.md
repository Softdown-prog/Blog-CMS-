# Persistência editorial v2 e publicador agendado — apenas arquitetura

## Estado atual
- Modelo SQL proposto: `database/proposals/002_editorial_storage_draft.sql`.
- Dispatcher offline: `apps/api/src/editorial/application/scheduled-dispatcher.ts`.
- Testes com porta simulada: `scheduled-dispatcher.spec.ts`.
- Nenhum container, cron, worker remoto, integração com Postgres, migration aplicada,
  rota HTTP, publicação real, PR ou deploy foi criado nesta etapa.

## Proposta de persistência
O esquema `001_initial.sql` está mantido. O arquivo 002 é um RASCUNHO
para **banco novo e vazio**, não um arquivo da cadeia executável `migrations/`.

Ele propõe:
1. `cms_posts.revision BIGINT`, não negativo, para comparar versões.
2. `cms_post_revisions.snapshot JSONB` de EditorialPost inteiro, com índice
   por post_id + revision decrescente e unicidade por (post_id, revision).
3. Índices para listagem administrativa e seleção de agendas vencidas.

Contrato transacional futuro:
- CreateDraft: INSERT do post e INSERT do snapshot revision 0 no mesmo COMMIT.
- CompareAndSave: UPDATE com `WHERE id = ? AND revision = ?` e INSERT do
  snapshot revision + 1 **na mesma transação**. Erros de unicidade/atualização
  concorrente devem ter semântica explícita, não substituir resultados.
- ScheduledPublish: deve verificar atomicamente `status='scheduled'`,
  revision original, data agendada igual, vencida segundo relógio confiável;
  executar UPDATE para published e gravar novo snapshot, no mesmo COMMIT.
- Qualquer falha => ROLLBACK. Não enviar e-mail, webhook ou outro efeito
  externo no interior dessa transação.

**Importante:** o modelo atual reutiliza `publishedAt` para a hora agendada
quando `status='scheduled'`. Antes de qualquer integração real, decidir e
executar refatoração para campos distintos `scheduledAt` e `publishedAt`.
Não misturar as semânticas durante a implantação.

**Pendência de auditoria:** a tabela existente exige `editor_id` ligado a um
usuário. Uma publicação automática precisa de identidade de serviço auditável,
sem login interativo, ou de um modelo formal de origem de alterações. Não há
implementação disso ainda. O protótipo não pode ser considerado banco pronto.

## Dispatcher e idempotência
`ScheduledPublicationDispatcher.runOnce(limit=25)` obtém um único timestamp
ISO UTC, busca no máximo 50 candidatos vencidos com a porta `listDue`, valida
ordem, duplicação, datas, formatos e campos inesperados e executa cada
`publishIfDue` sequencialmente. Candidatos malformados bloqueiam o lote.

A porta `publishIfDue` responde `published` ou `skipped`. O segundo valor
significa que o post foi editado, reagendado, cancelado ou publicado por outro
runner desde a seleção. Uma execução repetida não deverá publicar novamente,
**desde que o futuro adaptador cumpra o CAS atômico**. A classe por si só não
oferece lock distribuído nem garantia real de exactly-once.

Erros inesperados do adaptador são propagados sem afirmar sucesso. Um erro após
alguns itens pode ter deixado alterações já commitadas; repetir deverá ser
seguro via CAS. Idempotência de notificações, cache e indexação exigirá uma
outbox transacional e consumidor idempotente, ainda não implementados.

## Testes reais ainda obrigatórios
- Migrar duas vezes do zero e testar reversibilidade/compatibilidade em banco
  PostgreSQL descartável, incluindo histórico de revisions, constraints e índices.
- Corrida entre dois processos/conexões ao mesmo banco; cancelamento e
  reagendamento entre SELECT e UPDATE; rollback em falha no INSERT de revisão.
- Controles de segurança e sessão HTTP para o painel administrativo.
- Navegador real/Guardian/Chromium, mobile e recursos de acessibilidade.
- Medir RAM, disco e limites antes de qualquer deploy na VPS.

## Integração SAC
GitHub Actions executa os testes Node/TypeScript/Nest e consulta o Data_libray
SAC para preflight, compilação Angular AOT e pós-build. A aprovação estática
não autoriza deploy nem confirma funcionalidades no navegador.
