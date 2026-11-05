# Segurança antes da produção

- Não expor administração funcional sem autenticação (sessões HttpOnly, Secure, SameSite, CSRF).
- Senhas com Argon2id, limitação de tentativas, revogação de sessão e RBAC server-side.
- Validar entradas com DTO + validation pipe; proteger uploads por tipo, tamanho, nome e extensão.
- Renderizar conteúdo rich-text com política explícita de sanitização/links, independente da confiança do editor.
- PostgreSQL: criar um banco e usuário exclusivos, mínimos privilégios; migration por operador autorizado.
- Docker: imagens fixadas, não usar privileged, portas internas, limites de CPU/RAM e volumes persistentes.
- Medir recursos livres na VPS antes do deploy; **nenhum deploy automático**.
- Testes: API e auth, Angular AOT, SAC pre/post, Guardian, Playwright mobile, regressões de XSS e controle de acesso.

## Autorização administrativa sem integração

O contrato de verificação de sessão e permissões foi iniciado em apps/api/src/security/admin-session.ts. Confira ADMIN_SESSION_ARCHITECTURE.md para requisitos, limites e testes. Nenhuma rota de login, cookie ou banco de sessões foi ligada ao runtime.

## Credenciais e recuperação sem integração

Casos de uso puros e portas para senha Argon2id, reserva atômica de tentativas e recuperação de uso único foram adicionados. **Não há login HTTP nem envio de e-mail real.** Ver [CREDENTIALS_RECOVERY.md](CREDENTIALS_RECOVERY.md) para limitações, riscos e pré-requisitos de integração.

## Política de senha e auditoria tipada

Ver [PASSWORD_POLICY_AUDIT.md](PASSWORD_POLICY_AUDIT.md). São contratos isolados, sem banco, logs reais, endpoints ou integrações.

## Auditoria transacional pendente de integração

Os contratos de idempotência, outbox e projeção do ledger foram preparados em [AUDIT_OUTBOX_ARCHITECTURE.md](AUDIT_OUTBOX_ARCHITECTURE.md). Não substituir revisão de isolamento transacional em PostgreSQL por testes simulados.

## Logout e revogação global auditados internamente

`SessionLifecycle` agora exige `AtomicSecurityMutationPort` como parte obrigatória do próprio armazenamento de sessão. O commit de alteração+outbox ainda precisa ser comprovado em PostgreSQL descartável na etapa final. Não foi exposto nenhum endpoint ou worker.

## Emissão e rotação com auditoria obrigatória (contratos offline)

`SessionLifecycle.createWithAudit` e `rotateWithAudit` vinculam a alteração da sessão ao evento na outbox, sem inserir credenciais em registros. O adaptador PostgreSQL futuro ainda precisa demonstrar atomicidade, idempotência e concorrência real. Sem HTTP ou worker ativo.

## Preparação de uploads de mídia

Somente pré-validação e reserva simulada, sem ativação de endpoint, streams,
storage ou downloads. O cliente NÃO é confiável para MIME, dimensão ou bytes.
A gravação futura deve autenticar sessão + CSRF/Origin, verificar propriedade,
cotas sob transação e examinar/decodificar bytes em sandbox antes de permitir
publicação. Ver [MEDIA_UPLOAD_PREPARATION.md](MEDIA_UPLOAD_PREPARATION.md).
