# Blog CMS — critérios de utilidade e primeiro fluxo completo

Data da revisão: 2026-11-05.
Base revisada: `feat/cms-postgres-public-posts` em `b9eef7f`.

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
| Entrar e administrar | Regras de sessão e segurança sem login HTTP | `apps/api/src/security/`; `apps/api/src/app.module.ts` | Login real com sessão segura, CSRF/Origin, RBAC e logout |
| Publicar artigo | Política interna, sem rota de escrita | `apps/api/src/editorial/application/commands.ts` | Editor/admin publica e o leitor consegue abrir o artigo completo |
| Listar artigos públicos | Endpoint de listagem implementado, depende do banco | `apps/api/src/posts.controller.ts`; `posts.service.ts` | Consulta somente publicados, com paginação e tratamento de falhas |
| Abrir artigo por endereço | Falta rota pública de detalhe | `apps/web/src/app/app.routes.ts` | `/posts/:slug` mostra artigo correto, escapado e acessível |
| Categorias, tags, capa e mídias | Interfaces e contratos demonstrativos | `apps/web/src/app/admin-preview.component.ts` | Persistem associadas ao artigo, com permissões; podem vir depois do fluxo principal |
| Upload, quotas, miniaturas | Somente contratos offline e testes com fakes | `apps/api/src/editorial/media-upload-*.ts` | Adiar até salvar/publicar funcionar e existir validação real de bytes |
| Agendador, revisões, auditoria | Casos de uso e contratos testados, não integrados | `apps/api/src/editorial/application/`; `security/` | Habilitar apenas quando o fluxo correspondente for integrado e testado |

O endpoint `GET /api/public/posts` não é uma lista falsa: consulta PostgreSQL
quando configurado e retorna indisponibilidade quando não há conexão.
A tela pública ainda não fornece navegação até um artigo completo.

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
