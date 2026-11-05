# Auditoria de segurança transacional e outbox — somente arquitetura

## Estado
O módulo puro `apps/api/src/security/audit-outbox.ts` não está registrado em NestJS,
rotas HTTP, jobs, worker, banco PostgreSQL, Angular ou infraestrutura. Nenhuma integração,
PR, merge ou deploy será realizado nesta fase.

## Problema
Uma escrita isolada em `SecurityAuditWriter.append()` depois de revogar uma sessão
pode falhar após a revogação ter sido confirmada. O sistema ficaria sem evidência
durável do evento. Um retry cego também pode gerar registros repetidos.

## Etapa A — transação da operação sensível com outbox
`CommitAuditedSessionMutation` recebe um comando interno estritamente validado:
`operationId`, `correlationId`, `userId`, `sessionHash`, `expectedAuthVersion`,
`kind` = `revoke-session` ou `revoke-all-sessions`. Nunca passar token de
sessão, cookies ou senha. IDs são UUIDs válidos e `sessionHash` é SHA-256 hex.
O UUID da operação é interno, criado UMA VEZ por tentativa de negócio e
reutilizado em retries. Não aceitar idempotency key arbitrária do cliente.

`AtomicSecurityMutationPort.applyWithAudit` deverá executar tudo numa única
transação serializável ou equivalente comprovado por testes de concorrência:
1. Reserva `operationId` como chave UNIQUE, com fingerprint canônico dos
   argumentos de negócio (não incluir horário de retry).
2. Se operação anterior idêntica foi confirmada, retornar `replayed` sem
   aplicar alteração nova ou recriar auditoria. Se reutilizar o ID com outro
   comando, retornar `conflict`.
3. Verificar `sessionHash`, usuário autenticado, estado ativo e versão atual
   na mesma transação; jamais confiar em ID de usuário do JSON do cliente.
4. Persistir revogação da sessão OU incremento de `authVersion` e inserir
   evento imutável na outbox com `eventId = operationId`.
5. COMMIT de mudança+outbox+idempotência ou ROLLBACK de tudo.
   Evento não pode existir isolado se a alteração não ocorreu.

**Integração interna concluída:** `SessionLifecycle.logout()` e
`SessionLifecycle.invalidateAll()` usam agora `CommitAuditedSessionMutation`
através do MESMO `SessionLifecycleStore` que lê sessões. As portas de escrita
direta foram removidas. Os métodos validam sessão, CSRF e Origin antes da porta
transacional; o CAS do adaptador futuro precisa revalidar tudo no COMMIT.
A emissão e rotação de sessão permanecem com seus contratos específicos; a
cobertura de auditoria dessas operações ainda precisa ser definida.

## Etapa B — projeção confiável do evento em ledger interno
`ProjectSecurityAuditOutbox.runOnce` é uma função offline, SEM scheduler.
Seleciona até 50 eventos válidos, em ordem `recordedAt,eventId`, e exige
leases exclusivos de 30 segundos com UUID de fencing em cada claim.
Se o processo morrer, o lease expira e outra execução pode retomar.

`AuditOutboxProjectionPort.finalizeClaim` deverá, EM UMA transação:
1. Validar exclusividade do lease, deadline e fencing UUID.
2. Inserir o evento original no ledger imutável (`UNIQUE eventId`).
3. Se evento idêntico já existir, não duplicar. Se conteúdo diferir,
   falhar e não sobrescrever o ledger.
4. Marcar outbox como confirmada na MESMA transação do ledger.
5. Em erro de ledger ou ACK, fazer ROLLBACK de ambos.

Isso busca **efeito único no ledger do próprio banco**, mas NÃO é garantia
de exactly-once para e-mail, fila ou serviços externos. Um consumidor externo
continua at-least-once com idempotência independente, se vier a existir.

## Segurança e privacidade
- Nunca colocar token, senha, corpo HTTP, URL, e-mail ou IP brutos no evento.
- Eventos seguem o esquema fechado de `security-audit.ts` e origem de usuário.
- Rejeitar campos extras ou eventos sem UUID/timestamp UTC canônico.
- `correlationId` deve ser gerado internamente, não arbitrariamente pelo navegador.
- Armazenar `sessionHash` apenas no registro transacional que exigir controle
  de concorrência; não incluí-lo no evento de auditoria de domínio.
- Definir privilégios mínimos e retenção dos ledgers antes de integrar.

## Evidência de testes
19 testes com portas e armazenamento em memória simulam deduplicação, CAS,
replay, rollback, perda de lease, recuperação após interrupção, fencing,
ledger preexistente, corrupção de evento e limites de lote.
Esses testes NÃO executam transações reais, nem provam isolamento PostgreSQL.

## Próximos requisitos, ainda pendentes
- Migrar base em banco descartável e validar constraints UNIQUE/idempotência.
- Rodar testes com conexões PostgreSQL simultâneas e falhas após INSERT.
- Medir atraso de outbox, backlog, número de retries, retenção/expurgo e
  alarmes de falhas sem registrar segredos.
- Integrar o adaptador SQL REAL dessa porta e testar autenticação HTTP/CSRF;
  a composição interna em TypeScript já foi implementada.
- Testes Guardian/Chromium/Playwright e auditoria de segurança HTTP.
- Somente depois disso: integrações e homologação; deploy com autorização.

## Observação
`RecordSecurityAudit` continua útil para contratos simples e não garante
atomicidade com mudanças de estado. Não usá-lo isoladamente para confirmar
mutações de segurança críticas.

## Emissão e rotação de sessões (fase offline)

`SessionLifecycleStore` agora exige `createWithAudit` e `rotateWithAudit`.
A criação grava `session-issued`, e a rotação grava `session-rotated`, com
UUID exclusivo e sujeito usuário. A transação futura deve vincular a escrita
na outbox ao INSERT da sessão ou ao CAS do token e CSRF, respectivamente.
Falha do INSERT de auditoria => ROLLBACK da sessão/crendenciais.
Nenhum token, hash de sessão, senha ou CSRF entra no registro de eventos.
Essas operações ainda não compartilham o protocolo de replay da revogação:
antes da integração final, projetar recuperação de confirmações de COMMIT
ambíguas sem enviar duas credenciais diferentes para uma mesma operação.
 
## Falhas ambíguas e retries verificados em simulação (continuação)

Testes adicionais exercitam:
- confirmação de COMMIT seguida de perda da resposta; repetir com o MESMO operationId original retorna replay;
- alteração dos argumentos com mesmo operationId é conflito, inclusive após COMMIT;
- erro anterior ao COMMIT é seguro para retry e não produz evento órfão;
- 20 retries paralelos de uma operação global incrementam authVersion apenas uma vez;
- 12 operações diferentes disputando a mesma sessão têm um único vencedor;
- resposta do ACK perdida após gravação do ledger não duplica registro;
- morte após claim, recuperação por lease e rejeição de lease antigo (fencing);
- evento idêntico já projetado e ACK ausente é marcado sem segundo INSERT;
- adaptador que retorna um estado não documentado falha explicitamente.

**Limite conhecido:** `SessionLifecycle.commitRevocation` ainda gera operationId novo a cada chamada.
A reutilização estável de ID entre retransmissões HTTP exige futuro adaptador que
recupere/associe a intenção original de forma autenticada. Até lá, a garantia
simulada vale para a porta `CommitAuditedSessionMutation`, não para o caminho
HTTP completo. Não alegar exactly-once entre serviços. Testes de isolamento
PostgreSQL, perda de conexão e rollback transacional real continuam pendentes.
