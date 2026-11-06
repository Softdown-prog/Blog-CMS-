# Blog CMS

CMS de blog próprio, hospedado exclusivamente na VPS. Repositório em implantação inicial.

## Stack
- **Angular 22 / TypeScript 6** — interface pública e painel administrativo (único frontend).
- **NestJS 11 / TypeScript** — API REST.
- **PostgreSQL 18** — banco de dados exclusivo do projeto na instância já existente da VPS.
- **Caddy + Docker** — publicação futura na VPS, sem Cloudflare Pages.
- **Data_libray / SAC** — auditoria pré-build, build oficial e pós-build por GitHub Actions.

## Estrutura e estado real

- `apps/web`: único frontend Angular. A lista pública navega para `/posts/:slug`,
  que exibe parágrafos, títulos, citações e listas com texto escapado. Referências
  de imagem mostram apenas seu texto ALT até existir mídia pública validada.
  `/login` autentica no NestJS e a rota `/admin` exige sessão válida; a bancada
  editorial permite salvar e reabrir rascunhos no PostgreSQL e publicar com permissão, mediante ação explícita. Mídias, tags, categorias e capas de demonstração ainda não persistem.
- `apps/api`: NestJS com leitura pública de lista e detalhe de artigos publicados
  via PostgreSQL quando configurado (`GET /api/public/posts` e
  `GET /api/public/posts/:slug`). Rascunhos, agendados e arquivados não são
  expostos; falhas do banco são 503, ausências são 404. Escrita editorial,
  uploads e vinculação real de categorias/imagens ainda não têm conexão HTTP de produção. O adaptador
  de login/sessão HTTP já usa Argon2id e PostgreSQL quando a configuração de
  autenticação está presente; sem configuração, retorna 503 sem fallback.
- `database/migrations` e `database/proposals`: SQL versionado/proposto (incluindo
  proposta 003 para sessões e segurança),
  **não aplicado à VPS**.
- `scripts/sac-build.mjs`: pipeline SAC; Playwright testa o editor (persistência simulada no navegador) e
  a navegação pública com respostas HTTP simuladas nos testes do navegador.
- `docs`: documentação e prioridades verificáveis.

**Organização pública em desenvolvimento:** feed de postagens e páginas fixas
separados, widgets nativos (últimas, populares, atalhos, texto puro) e configurações
administrativas em `/admin/site`. A proposta SQL 004 é somente para CI e não
foi aplicada à VPS. Ver [páginas e widgets](docs/CONTENT_LAYOUT_PROPOSAL.md).
A popularidade só existe com contagem real e chave de métricas configurada.

**Fluxo editorial implementado em código:** criar e salvar rascunhos, recarregar
por ID, revisar versão e publicar posts/páginas. O NestJS aplica sessão, CSRF,
RBAC e revisão otimista; o Angular executa cada ação explicitamente, sem
salvar automaticamente nem armazenar tokens no browser. Consulte
[docs/EDITORIAL_HTTP_MVP.md](docs/EDITORIAL_HTTP_MVP.md).

**Próxima prioridade:** homologar autenticação, banco, migrações e deploy em
ambiente seguro; depois persistir mídia, taxonomia e upload. Critérios e bloqueios:
[docs/CMS_MVP_PRIORITIES.md](docs/CMS_MVP_PRIORITIES.md).

## Desenvolvimento (Node 24.15+)
```sh
npm install --prefix apps/web
npm install --prefix apps/api
npm run start --prefix apps/api
npm run start --prefix apps/web
```
API: http://localhost:3000/api/health; web: http://localhost:4200.
Leitura pública depende de PostgreSQL configurado e artigos previamente publicados.
O login HTTP e o logout existem no código, mas dependem da proposta 003 aplicada
em base isolada e de variáveis de ambiente; não há cadastro automático de contas
nem homologação de proxy/segurança para produção. As rotas editoriais precisam
das propostas 002 e 004 aplicadas em banco isolado (e 003 para autenticação).
Veja `docs/ADMIN_SESSION_ARCHITECTURE.md` e `docs/EDITORIAL_HTTP_MVP.md`.
A bancada salva apenas texto e blocos editoriais sem imagens demonstrativas.
**Não implantar em produção.**

## Qualidade e integração
A CI obtém o `Data_libray` com commit fixado e executa seu SAC-PRE001 + build Angular oficial + SAC-P001 usando comprovante efêmero assinado. Veja `docs/SAC.md`.
Dependências ainda precisam de lockfiles versionados: a CI gera lockfiles temporários como artefatos para inspeção; isso é etapa de bootstrap, não garantia de build reprodutível.

Nenhuma destas etapas autoriza mudanças na VPS, no banco de produção ou deploy.


## Histórico de revisões do editor

A API e o editor Angular permitem consultar versões anteriores de rascunhos e
recuperar uma como nova revisão com CAS/CSRF, sem apagar o histórico.
Veja [Histórico e recuperação de versões](docs/EDITORIAL_HISTORY_HTTP.md).
