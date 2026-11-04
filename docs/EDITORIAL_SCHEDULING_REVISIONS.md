# Agendamento e histórico de revisões — contratos internos

## Arquitetura desta etapa
Nenhum endpoint administrativo, tarefa de background, conexão com a VPS, Postgres real, migração executada, merge ou deploy foi criado.

O núcleo de casos de uso continua em TypeScript puro, independente de Angular, NestJS e PostgreSQL. As rotas públicas e o painel ainda não consomem estas novas classes.

### ScheduleDraft
- Apenas editor e administrador podem agendar.
- O artigo deve estar em rascunho ou já agendado e ser publicável.
- Data ISO 8601 UTC **canônica** estritamente no futuro, comparada ao relógio injetado pelo servidor.
- A transição para scheduled salva a data prevista no campo publishedAt **como compatibilidade temporária** com a migração 001.
- Atualização exige expectedRevision e compare-and-swap do repositório; não aceita corrida entre edições.
- O estado scheduled **NÃO é publicado no blog**; falta implementar o serviço que confirmará a data e publicará.

### CancelSchedule
- Apenas editor e administrador podem cancelar artigo que esteja scheduled.
- Retorna para draft com data de publicação nula e nova revisão.
- Sem exclusão, sem envio a filas e sem alterações de artigo publicado.

### ListEditorialRevisions
- Revisões imutáveis, com postId, número da revisão, editor, timestamp UTC e snapshot editorial v1 completo.
- Autores leem apenas revisões dos próprios **rascunhos**.
- Editor e administrador podem consultar revisões de artigos de todos os estados.
- Paginação por revision DESC, limite 1–20 e marcador beforeRevision; validar antes de retornar.
- O repositório é obrigado a filtrar por postId, revision anterior e limite+1.
- A aplicação confirma autoria, ordenação, número, formatos e estrutura dos snapshots.
- Campos extras, dados de outro artigo ou conteúdo fora do schema falham fechados.

## Persistência futura (não implementada)
A migração 001 não dispõe de revision no post nem snapshot completo na tabela de revisões. Antes de conectar:
1. Projetar migração nova, testada em banco descartável, com coluna de revisão não negativa, histórico imutável e índices de consulta.
2. Criar snapshot da revisão 0 junto do insert inicial, na mesma transação.
3. Em compareAndSave, gravar o snapshot da nova revisão e o post no **mesmo commit transacional**, com CAS pela revisão esperada.
4. Rejeitar duplicação de slug e revisar constraints de status/data.
5. O dispatcher offline de publicações vencidas foi definido em `application/scheduled-dispatcher.ts`, porém **não existe scheduler ativo nem adaptador SQL**; falta garantir CAS em banco, telemetria e identidade de auditoria. Ver [PERSISTENCE_AND_SCHEDULER.md](PERSISTENCE_AND_SCHEDULER.md).

## Segurança e testes
Ator deve ser derivado de sessão autenticada no backend. Estes contratos não autentificam por conta própria e não podem ser expostos em controller antes de RBAC, CSRF e rate limit. Regras do domínio não substituem a autorização HTTP.

Os testes usam repositórios simulados: permissão, datas, agendamento/cancelamento, concorrência, visibilidade de revisões, paginação e resistência a respostas incorretas. A CI executa TypeScript/Nest, testes, SAC-PRE001, Angular AOT e SAC-P001 do Data_libray. Isso não é teste PostgreSQL nem Guardian/Chromium.
