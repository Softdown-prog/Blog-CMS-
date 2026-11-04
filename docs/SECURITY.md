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
