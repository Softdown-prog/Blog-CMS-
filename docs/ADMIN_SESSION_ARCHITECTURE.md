# Administração CMS — sessão e autenticação

## Estado da integração (branch de trabalho)

O adaptador HTTP real foi conectado em `apps/api/src/security/admin-auth.controller.ts`
usando os casos de uso existentes `VerifyPasswordLogin`, `AdminSessionAccess`
e `SessionLifecycle`. Os endpoints são `POST /api/admin/login`,
`GET /api/admin/session`, `POST /api/admin/rotate` e
`POST /api/admin/logout`. O Angular tem `/login` e um guard em `/admin`,
mas a bancada editorial permanece demonstração SEM salvar/publicar.

A proposta `database/proposals/003_admin_auth_draft.sql` só pode ser testada
em **PostgreSQL 18 descartável** após 001 e 002, nunca aplicada
automaticamente na VPS. Sem `DATABASE_URL`, `CMS_APP_ORIGIN` e
`CMS_AUTH_HMAC_SECRET`, as rotas administrativas retornam HTTP 503.
Nenhuma credencial administrativa ou seed padrão é criada.

## Configuração em ambiente de integração isolado

- `DATABASE_URL`: endereço privado de banco exclusivo do CMS, com propostas
  revisadas e aplicadas SOMENTE em ambiente de testes.
- `CMS_APP_ORIGIN`: origem canônica da página Angular (HTTPS em produção;
  HTTP permitido somente em localhost/loopback). Não incluir path ou barra.
- `CMS_AUTH_HMAC_SECRET`: segredo aleatório independente, com no mínimo
  32 bytes, fora do Git. Não reutilizar senhas/keys de outros projetos.
- Usuários existentes precisam de email normalizado em minúsculas, hash
  Argon2id PHC válido, `enabled=true` e `auth_version`.

O serviço `@node-rs/argon2` valida Argon2id com limites de custos, impede
verificação excessivamente cara de hashes adulterados e usa hash de trabalho
para email inexistente. Uma tentativa é reservada atomicamente no Postgres
por e-mail (HMAC, até 5/15 min) e rede (até 25/15 min). O IP usa
`request.socket.remoteAddress` e IGNORA `X-Forwarded-For` não confiável;
antes de produção atrás do Caddy, configurar proxy confiável por IP/identidade
e testar limites sem punir todos os visitantes por compartilharem o IP do proxy.

## Confiança, autorização e sessão

O token opaco de 256 bits é enviado exclusivamente em cookie HttpOnly,
SameSite=Strict e Secure quando HTTPS. CSRF usa cookie separado legível pelo
Angular e cabeçalho `X-CMS-CSRF` verificado por hash persistido na sessão.
O servidor verifica o Origin exato em todas as operações de escrita;
credenciais, identidade e papel NÃO são aceitos do body após login.
Hashes SHA-256 são armazenados; valores claros não entram na base nem logs.

Sessões duram no máximo 8 horas com expiração por inatividade de 30 minutos.
Renovação troca token de sessão e CSRF atomicamente; logout revoga sessão e
insere evento na outbox na mesma transação. Papéis são lidos do usuário ativo
a cada autorização. Não existe fallback em memória ou administrador fixo.
A autorização de propriedade de rascunhos continuará no domínio editorial;
**nenhuma rota de escrita está habilitada** nesta etapa.

## Verificação e limitações antes de deploy

Os testes de integração com banco descartável exercitam HTTP real, cookie,
CSRF, Argon2id, logout, renovação, tentativas concorrentes e rollback de
auditoria. Playwright exercita o formulário e a navegação com API simulada
em desktop/mobile. SAC/AOT sozinhos não certificam comportamento em produção.

**Pendente:** testar com Caddy real e HTTPS no ambiente de homologação;
provisionamento seguro de usuários; política de migração em banco povoado;
poda/retencão de sessões, rate limit e outbox; proteção contra spoofing de
forwarded headers quando proxy for confiável; lockfiles reprodutíveis;
cabeçalhos de segurança; teste de ataques/concorrência prolongado; expansão
para autenticar comandos editoriais e comprovação do fluxo salvar-publicar.
Não implantar ainda.
