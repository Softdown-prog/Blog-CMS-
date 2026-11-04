# Administração CMS — arquitetura de sessão e autorização

## Escopo
Novo código isolado: apps/api/src/security/admin-session.ts, com testes unitários.
Nenhum endpoint, login, emissão de cookies, banco real ou integração NestJS foi criado.
O módulo não foi registrado no AppModule e não altera a API pública.

## Confiança e identificação
O futuro adaptador HTTP deve ler o token de sessão APENAS de cookie de servidor HttpOnly, Secure e SameSite.
O cabeçalho CSRF deve vir de header separado e a Origin deve ser validada; nunca aceitar identidade, role ou token do JSON do cliente.
Token de sessão e CSRF são valores CSPRNG independentes de 32 a 64 bytes em base64url canônico.
O armazenamento futuro deverá persistir somente seus hashes SHA-256, e nunca os valores originais.
O leitor injeta a sessão e o usuário atual em cada chamada, sem confiar em role histórica.

## Autorização
AdminSessionAccess verifica token, digest em tempo constante, expiração absoluta, inatividade, revogação, usuário ativo e authVersion.
Após a validação, produz EditorialActor com id e role lidos do usuário atual no servidor.
Autor pode listar, ler revisões e gerenciar somente seus próprios rascunhos (o escopo individual é verificado também pelos casos de uso editoriais).
Editor pode publicar, agendar e cancelar; administrador adicionalmente pode gerenciar usuários.
Ações desconhecidas ou sem permissão são recusadas por padrão.

## CSRF e origem
Todas as operações de escrita exigem cabeçalho CSRF vinculado à sessão e Origin exatamente igual à origem configurada.
Leituras também exigem sessão válida, mas não requerem token CSRF.
A origem de aplicação precisa usar HTTPS, exceto localhost/loopback em testes locais.
SameSite é defesa em profundidade, não substitui validação de CSRF nem verificação de origem.

## Lacunas antes da integração
- Ainda não existem login, senha Argon2id, emissão ou rotação de token, logout ou limpeza de sessões.
- Não foram implementados Nest Guards, rate limiting, proteção contra fixation e políticas de cabeçalhos.
- O esquema 001 não tem enabled/auth_version em cms_users nem tabela de sessões.
- Aplicar migrações e garantir revogação atômica apenas em ambiente descartável durante os testes finais.
- Exercitar integração HTTP real, Playwright/Guardian, ataques IDOR e cenários mobile.
- Proibido abrir administração funcional sem completar autenticação e autorização reais.

## Ordem do projeto
Contratos puros -> casos de uso e segurança -> interface Angular -> testes isolados e navegador -> integrações e PostgreSQL -> homologação -> deploy.
SAC/Data_libray verifica compilação e conteúdo estático; uma CI verde não significa login em produção pronto.
