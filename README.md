# Blog CMS

CMS de blog próprio, hospedado exclusivamente na VPS. Repositório em implantação inicial.

## Stack
- **Angular 22 / TypeScript 6** — interface pública e painel administrativo (único frontend).
- **NestJS 11 / TypeScript** — API REST.
- **PostgreSQL 18** — banco de dados exclusivo do projeto na instância já existente da VPS.
- **Caddy + Docker** — publicação futura na VPS, sem Cloudflare Pages.
- **Data_libray / SAC** — auditoria pré-build, build oficial e pós-build por GitHub Actions.

## Estrutura e estado real

- `apps/web`: único frontend Angular; a bancada `/admin` é demonstrativa e
  mantém o rascunho apenas em memória, sem botão de salvar/publicar.
- `apps/api`: NestJS com leitura pública de metadados de artigos via PostgreSQL
  quando o banco está configurado; casos de uso editoriais, autenticação e
  uploads ainda sem conexão HTTP de produção.
- `database/migrations` e `database/proposals`: SQL versionado/proposto,
  **não aplicado à VPS**.
- `scripts/sac-build.mjs`: pipeline SAC; Playwright testa a bancada offline.
- `docs`: documentação e prioridades verificáveis.

**Próxima prioridade:** fechar o fluxo real escrever -> salvar -> publicar ->
ler, antes de adicionar mais módulos periféricos. Critérios e bloqueios:
[docs/CMS_MVP_PRIORITIES.md](docs/CMS_MVP_PRIORITIES.md).

## Desenvolvimento (Node 24.15+)
```sh
npm install --prefix apps/web
npm install --prefix apps/api
npm run start --prefix apps/api
npm run start --prefix apps/web
```
API: http://localhost:3000/api/health; web: http://localhost:4200.
Sem autenticação HTTP, escrita editorial ligada ao banco ou upload real; a bancada é uma demonstração. **Não implantar em produção.**

## Qualidade e integração
A CI obtém o `Data_libray` com commit fixado e executa seu SAC-PRE001 + build Angular oficial + SAC-P001 usando comprovante efêmero assinado. Veja `docs/SAC.md`.
Dependências ainda precisam de lockfiles versionados: a CI gera lockfiles temporários como artefatos para inspeção; isso é etapa de bootstrap, não garantia de build reprodutível.

Nenhuma destas etapas autoriza mudanças na VPS, no banco de produção ou deploy.

