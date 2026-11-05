# Políticas de senha e auditoria de segurança — arquitetura offline

## Situação
Implementados como módulos TypeScript puros sem chamadas HTTP e sem efeitos externos.
Arquivos: `apps/api/src/security/new-password-policy.ts` e `apps/api/src/security/security-audit.ts`.
Testes próprios e cobertura adicional em `password-recovery.spec.ts`.
NÃO há integração com Nest Guards, banco, serviços de e-mail, Angular, VPS ou deploy.

## Política para senhas NOVAS
- Mínimo de 15 pontos de código Unicode e máximo de 1024 bytes UTF-8.
- Aceita frases longas sem exigir letras maiúsculas, dígitos ou símbolos.
- Não altera a senha (sem trim ou normalização); rejeita controles invisíveis, bidi perigoso e surrogates inválidos.
- `PasswordBlocklist.containsCandidate` é uma porta obrigatória para verificar credenciais comprometidas/comuns.
- Um erro ao consultar o corpus não aprova a senha; a falha é propagada.
- O corpus real NÃO existe ainda. Implementar com base local ou consulta que NÃO envie senha original a terceiros.
- Não aplicar essa política nova à verificação de senhas antigas para evitar bloqueio involuntário de usuários existentes.
- O fluxo de recuperação invoca a política ANTES de acionar o hash Argon2id e retorna erro genérico ao cliente.
- Checagem de reutilização de senha, parâmetros Argon2id e bloqueio por corpus grande ainda exigem projeto e testes.

## Auditoria de segurança
Eventos permitidos: login-approved, session-issued, session-rotated, login-rejected, login-throttled, password-reset-requested,
password-reset-rejected, password-reset-completed, session-revoked, sessions-revoked-all.
Cada registro tem schemaVersion, eventId UUID, correlationId UUID, tipo, sujeito e instante ISO UTC canônico.
Eventos de usuário aceitam apenas `{kind:user,userId:<UUID>}`.
Eventos anônimos aceitam apenas `{kind:anonymous,subjectKey:<HMAC-HEX>}`.
O HMAC deverá ser calculado pelo futuro adaptador interno com segredo protegido; NUNCA usar IP ou email bruto nem hash simples previsível.
Dados extras são rejeitados: senha, token, endereço de email, IP, user-agent, URL e mensagens livres não entram no registro.
Registro novo é criado por whitelist, sem repassar objetos externos. Erro no armazenamento propaga.

## Limitações críticas
- AuditWriter é somente porta: NENHUM evento é gravado durante o login real hoje.
- Sucessos de mutações críticas precisam coordenar a escrita de auditoria com a transação de estado
  ou com outbox transacional, impedindo perder auditoria depois de confirmar operação.
- O futuro serviço precisará de políticas de acesso mínimo, retenção/expurgo, proteção e rotação de chaves HMAC.
- Eventos de pedidos de recuperação precisam preservar resposta genérica para impedir enumeração de contas.
- Os testes não comprovam resistência de Argon2id, confiabilidade do corpus, persistência de auditoria
  nem funcionalidade de navegador.

## Sequência
Arquitetura e testes internos -> UI e segurança de domínio -> browser e fuzz -> integrações somente no fim -> homologação -> deploy.
CI SAC e compilação verde NÃO autorizam produção.

## Audit outbox (contratos ainda offline)

O contrato `CommitAuditedSessionMutation` exige persistir alteração de sessão e evento na MESMA transação; `ProjectSecurityAuditOutbox` define leases e ACK transacional no ledger interno. Veja [AUDIT_OUTBOX_ARCHITECTURE.md](AUDIT_OUTBOX_ARCHITECTURE.md). Não há worker ou banco conectados.
