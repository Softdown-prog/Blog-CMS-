# Blog CMS — critérios de utilidade e primeiro fluxo completo

Data da revisão: 2026-11-05.
Base revisada: `feat/cms-postgres-public-posts`, com leitura pública por slug.

## Regra antes de implementar

Não criar novos módulos, eventos, logs, schemas ou frameworks apenas porque
o desenvolvimento recebeu a instrução genérica "vamos continuar".

Uma tarefa só entra quando:
1. Resolve uma dificuldade concreta para autor, editor, administrador ou leitor;
2. Reutiliza os contratos existentes sempre que possível, sem duplicar lógica;
3. Tem critério de aceite observável (incluindo interação real no navegador);
4. Não aumenta a superfície de ataque sem necessidade;
5. Aproxima um fluxo de ponta a ponta utilizável ou corrige um defeito concreto.

Quando não houver ganho demonstrável, preferir auditoria, consolidação ou
adiar a ideia. Testes verdes comprovam cenários testados, não utilidade nem
prontidão para produção.

## Situação encontrada no código

| Fluxo | Hoje | Evidência | Aceite para considerar pronto |
| --- | --- | --- | --- |
| Escrever artigo | Demonstrativo e em memória | `apps/web/src/app/admin-preview.component.ts` | Autor escreve com teclado/touch e não perde conteúdo após salvar |
| Salvar rascunho | Caso de uso interno; não ligado ao navegador | `apps/api/src/editorial/application/commands.ts` | Salvar, recarregar e recuperar do banco com revisão/autor corretos |
| Entrar e administrar | Login/sessão/logout HTTP e proteção da rota Angular implementados; sem implantação, cadastro ou fluxo de escrita | `apps/api/src/security/admin-auth.controller.ts`; `apps/web/src/app/admin-auth.guard.ts` | Testes HTTP/PostgreSQL 18/Playwright; exigir homologação de Caddy, limites de rede, retenção e provisão antes de produção |
| Publicar artigo | Política interna, sem rota de escrita | `apps/api/src/editorial/application/commands.ts` | Editor/admin publica e o leitor consegue abrir o artigo completo |
| Listar artigos públicos | Endpoint de listagem implementado, depende do banco | `apps/api/src/posts.controller.ts`; `posts.service.ts` | Consulta somente publicados, com paginação e tratamento de falhas |
| Abrir artigo por endereço | Rota pública e leitura por slug implementadas, dependem de PostgreSQL e conteúdo válido | `apps/api/src/posts.service.ts`; `apps/web/src/app/post-detail.component.ts` | HTTP 200/404/503, SQL parametrizado, texto escapado, testes desktop/mobile; validar também com dados reais antes da produção |
| Categorias, tags, capa e mídias | Interfaces e contratos demonstrativos | `apps/web/src/app/admin-preview.component.ts` | Persistem associadas ao artigo, com permissões; podem vir depois do fluxo principal |
| Upload, quotas, miniaturas | Somente contratos offline e testes com fakes | `apps/api/src/editorial/media-upload-*.ts` | Adiar até salvar/publicar funcionar e existir validação real de bytes |
| Agendador, revisões, auditoria | Casos de uso e contratos testados, não integrados | `apps/api/src/editorial/application/`; `security/` | Habilitar apenas quando o fluxo correspondente for integrado e testado |

O endpoint `GET /api/public/posts` não é uma lista falsa: consulta PostgreSQL
quando configurado e retorna indisponibilidade quando não há conexão.
A lista pública agora oferece navegação para o artigo completo; o teste Angular
simula respostas da API, e o teste NestJS exercita a rota HTTP real com banco
falso. A publicação pelo painel continua bloqueada por falta de autenticação.

## Sequência mínima de maior valor

1. **Base de execução confiável:** versionar/verificar lockfiles e preparar
   banco descartável; validar migração e atomicidade real antes de usar dados.
2. **Autenticação utilizável:** ligar a segurança existente a endpoints HTTP
   seguros, sem permitir que o cliente declare seu próprio ator/permissões.
3. **Rascunho de ponta a ponta:** conectar Angular -> NestJS -> PostgreSQL
   com salvar, carregar, permissão por autor, concorrência e revisão; testar
   no Chromium desktop e mobile emulado, inclusive recarregar.
4. **Publicação mínima:** autorização editor/admin, transação e histórico,
   listagem pública, detalhe por slug e navegação funcional.
5. **Organização editorial:** persistir categorias, tags, capa e mídias
   conforme necessidade real do fluxo editorial.
6. **Upload real e agendamento:** só depois do fluxo básico estável;
   exigir validações de segurança e testes de falhas do armazenamento/worker.

Essa ordem é uma proposta de integração futura, não autorização para fazer
deploy, alterar banco existente ou remover limites de segurança.
Manter a `main` estável; concluir e testar cada microtarefa na branch.

## "Pronto" significa

- O autor consegue entrar, criar, salvar, fechar/recarregar e continuar.
- O editor/admin consegue publicar; o visitante consegue listar e abrir.
- Usuários sem permissão NÃO conseguem salvar/publicar, nem ver dados alheios.
- Requisições repetidas ou concorrentes não duplicam revisão, artigo ou ação.
- Testes SQL reais em banco descartável, NestJS, Angular AOT/SAC, Playwright
  desktop/mobile e revisão de segurança aprovados.
- Documentação distingue recurso disponível, demonstrativo e planejado.

Até isso acontecer, não anunciar "CMS completo" com base no número de testes.
Não introduzir sistemas de plugins, marketplaces, AI/SEO automático,
analytics avançado, novos bancos, frameworks ou microserviços sem uma
necessidade demonstrada.

## Progresso da base PostgreSQL (sem publicar)

O adaptador `PgEditorialRepository` e os testes SQL foram adicionados
para exercitar os mesmos casos de uso existentes contra Postgres 18 real
em banco descartável do Actions. Isso cobre uma parte do item 1, mas
**lockfiles versionados, autenticação HTTP e conexão do Angular ainda
estão pendentes**. Não registrar o adaptador no NestJS antes da fronteira
de autenticação/CSRF. Ver `docs/POSTGRES.md`.

## Leitura de artigo (implementada, sem deploy)

- A API utiliza slug validado e SQL parametrizado e lê somente posts publicados
  com data já efetiva. Ausência/slug inválido retorna HTTP 404; PostgreSQL
  indisponível ou corpo editorial corrompido retorna HTTP 503 sem vazar driver.
- O corpo JSONB é validado contra o contrato editorial v1 já existente. A
  interface usa interpolação Angular, nunca `innerHTML`; referências de imagem
  exibem ALT em texto enquanto o upload público não existir.
- Testes unitários, HTTP real (NestJS com fake de banco) e Playwright
  desktop/mobile cobrem navegação, XSS, erros e viewport. **Não substituem**
  teste com PostgreSQL real populado com artigos publicados nem verificam login.
- A criação, edição, publicação e fluxo de sessão continuam pendentes. Nenhuma
  migration foi aplicada à VPS, e nenhuma funcionalidade administrativa foi
  exposta sem autenticação.

## Sessão administrativa HTTP — etapa implementada na branch

- **Código:** NestJS recebe login por e-mail/senha, entrega cookie de sessão
  HttpOnly e cookie CSRF separado, suporta `GET /api/admin/session`,
  `POST /api/admin/rotate` e `POST /api/admin/logout`, e nega ações sem
  Origin exata, cabeçalho CSRF ou sessão ativa.
- **Persistência:** proposta 003 contém tabelas de sessões, rate limit e
  outbox. Adapter PostgreSQL valida `authVersion`, faz mutações e auditoria na
  mesma transação e reserva tentativas atomically (por conta/rede).
- **Angular:** formulário `/login`, guard na rota `/admin`, logout e
  indicação explícita de que a bancada continua offline. Não há rotas de
  escrita editorial; o frontend não guarda sessão em `localStorage`.
- **CI:** testa emissão, renovação, logout, autenticação Argon2id e rollback
  SQL em banco descartável; Playwright emula UI e HTTP de login (respostas
  simuladas). Não são testes de deploy, nem do proxy Caddy real.
- **Bloqueios:** revisão de segurança, criação segura da primeira conta,
  migração de banco povoado, alinhamento de proxy/IP confiável, retenção de
  tentativas/sessões, lockfiles, controles de cabeçalhos e homologação mobile
  com a API real. NÃO executar 003 na VPS sem autorização e revisão.
