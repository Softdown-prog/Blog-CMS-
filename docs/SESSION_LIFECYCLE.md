# Sessões administrativas: ciclo de vida — contratos offline

## Status
Implementado como TypeScript independente em apps/api/src/security/session-lifecycle.ts.
Não é um login funcional. Não há controller Nest, serviço de autenticação, cookie HTTP,
middleware, banco de dados, worker ou deploy. Integrar somente na etapa final.

## Emissão
issue() só poderá ser chamado pelo verificador futuro que JÁ comprovou senha e
fatores exigidos. VerifiedLogin é uma entrada interna CONFIÁVEL, NÃO um DTO de cliente.
Uma chamada HTTP que aceite VerifiedLogin arbitrário daria acesso indevido.
A prova expira em cinco minutos e é conferida contra usuário ativo e authVersion.
A porta `createWithAudit` deverá inserir a sessão e um evento `session-issued`
na outbox na MESMA transação, verificando `enabled` e `authVersion` atuais.
Se a auditoria falhar, nenhuma sessão pode ser emitida.
O gerador padrão CryptographicSessionSecrets usa randomBytes(32) do Node.
Sessão e CSRF recebem tokens distintos de 256 bits e base64url canônico.
Somente digests SHA-256 são entregues ao armazenamento; valores originais
retornam apenas à fronteira segura de resposta para cookie/CSRF, nunca aos logs.

## Renovação
rotate() exige sessão válida, Origin exata e token CSRF correto.
Rotação substitui session token e CSRF de modo indivisível, invalida o anterior
e preserva a expiração absoluta de 8 horas. O limite de inatividade é de 30 minutos.
A porta `rotateWithAudit` faz compare-and-swap no hash anterior, `authVersion`
atual, usuário ativo, prazo e revogação. Também grava `session-rotated` na
outbox no mesmo COMMIT, ou desfaz toda a rotação. Duas rotações concorrentes
não podem ser aceitas ambas; não renovar sessão expirada ou revogada.

## Logout
logout() valida sessão, CSRF e Origin; então chama o contrato auditado
`CommitAuditedSessionMutation` com `revoke-session`. A transação futura deve
marcar `revokedAtMs` e inserir a outbox no mesmo COMMIT. Não há porta direta
`revokeIfCurrent` que permita contornar a auditoria.
O cliente futuro removerá cookie imediatamente, mesmo em erro; não implementado.

## Encerrar todas as sessões
invalidateAll() autoriza a ação pela sessão atual com CSRF/Origin e exige
`CommitAuditedSessionMutation` com `revoke-all-sessions`. A transação futura
incrementa `authVersion` e registra evento na outbox no mesmo COMMIT.
Todas as sessões com versão anterior tornam-se inválidas, mesmo que seus
registros ainda existam fisicamente até expurgo seguro. Não pode direcionar
a operação a outro usuário por parâmetro recebido do cliente.

## Contrato do adaptador persistente futuro
SessionLifecycleStore estende AdminSessionReader:
- createWithAudit: inserir somente se usuário ativo e versão atual, com evento de emissão na mesma transação;
- rotateWithAudit: validar sessão e usuário, trocar token e CSRF e inserir evento de rotação no mesmo COMMIT;
- applyWithAudit: CAS da sessão/usuário, alteração de estado, idempotência
  e INSERT do evento na outbox no mesmo COMMIT (sem perder auditoria);
- findSessionByHash e findUserById: carregar estado atual, sem cache de permissões.
Não confundir teste em memória com testes transacionais em PostgreSQL.
Falha de persistência propaga exceção, nunca deve retornar sucesso falso.

## Limitações e próximos passos
- Implementar verificação real de senha Argon2id, MFA quando aplicável e rate limiting.
- Definir rotação ao login e mitigação de session fixation.
- Criar guards, cookies HttpOnly + Secure + SameSite e canal seguro para token CSRF.
- Implementar índices, retenção/expurgo, trilha de auditoria e migrations sob testes.
- Verificar concorrência em duas conexões PostgreSQL, logout entre read/CAS e revogação global.
- Guardian/Playwright mobile, segurança de navegador e testes de CSRF/IDOR.
- Publicação somente após homologação e autorização de deploy.

## Testes
Testes isolados de emissão, formato e hashes, prazo absoluto e idle, rotação
repetida/concorrente, CSRF, logout e revogação global. SAC pre/build/post
continua na CI, sem autorizar deploy.

## Autenticação prévia ao issue

O contrato `VerifyPasswordLogin` agora pode produzir uma prova interna `VerifiedLogin` quando um `PasswordVerifier` confiável aceitar uma senha e o limitador conceder uma tentativa. **Esta prova não deve ser exposta como DTO HTTP**. Ver [CREDENTIALS_RECOVERY.md](CREDENTIALS_RECOVERY.md). A integração real com Argon2id, limitação compartilhada e recuperação está pendente.

## Auditoria atômica conectada internamente (sem infraestrutura)

`SessionLifecycle` agora exige que o MESMO `SessionLifecycleStore` implemente
`AtomicSecurityMutationPort`: logout e revogação global obrigatoriamente passam
por `CommitAuditedSessionMutation`. Emissão e rotação exigem `createWithAudit` e
`rotateWithAudit`, sem portas de escrita que ignorem o registro de auditoria. Operação e correlação
recebem UUIDs novos do servidor; a repetição idempotente com um ID estável é
suportada pela porta auditada, mas ainda não é propagada por uma camada HTTP.
O adaptador SQL real, a autenticação HTTP, a transação e o consumer da outbox
continuam pendentes. Ver [AUDIT_OUTBOX_ARCHITECTURE.md](AUDIT_OUTBOX_ARCHITECTURE.md).

## Integridade de eventos de emissão e rotação

Os eventos `session-issued` e `session-rotated` são construídos no serviço
interno a partir do usuário autenticado e UUIDs criptográficos; nunca recebem
o token de sessão, o token CSRF ou seus hashes. Testes de portas simuladas
verificam rollback lógico e concorrência, sem substituir isolamento SQL.
Se houver confirmação ambígua de COMMIT, reemitir automaticamente outro token
não é seguro: a futura integração precisa de protocolo de idempotência de
emissão/rotação e estratégia de entrega de credenciais sem duplicação.
