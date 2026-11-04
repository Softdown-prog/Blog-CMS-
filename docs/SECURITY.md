# Segurança antes da produção

- Não expor administração funcional sem autenticação (sessões HttpOnly, Secure, SameSite, CSRF).
- Senhas com Argon2id, limitação de tentativas, revogação de sessão e RBAC server-side.
- Validar entradas com DTO + validation pipe; proteger uploads por tipo, tamanho, nome e extensão.
- Renderizar conteúdo rich-text com política explícita de sanitização/links, independente da confiança do editor.
- PostgreSQL: criar um banco e usuário exclusivos, mínimos privilégios; migration por operador autorizado.
- Docker: imagens fixadas, não usar privileged, portas internas, limites de CPU/RAM e volumes persistentes.
- Medir recursos livres na VPS antes do deploy; **nenhum deploy automático**.
- Testes: API e auth, Angular AOT, SAC pre/post, Guardian, Playwright mobile, regressões de XSS e controle de acesso.

