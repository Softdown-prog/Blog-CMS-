# Blog CMS

CMS de blog próprio, hospedado exclusivamente na VPS. Repositório em implantação inicial.

## Stack
- **Angular 22 / TypeScript 6** — interface pública e painel administrativo (único frontend).
- **NestJS 11 / TypeScript** — API REST.
- **PostgreSQL 18** — banco de dados exclusivo do projeto na instância já existente da VPS.
- **Caddy + Docker** — publicação futura na VPS, sem Cloudflare Pages.
- **Data_libray / SAC** — auditoria pré-build, build oficial e pós-build por GitHub Actions.

## Estrutura
- `apps/web`: base Angular com rota pública e prévia da área administrativa.
- `apps/api`: base NestJS com endpoints de saúde e listagem pública vazia.
- `database/migrations`: migração SQL inicial, **não executada**.
- `scripts/sac-build.mjs`: host confiável que usa o pipeline SAC do Data_libray.
- `docs`: decisões, segurança e etapas restantes.

## Desenvolvimento (Node 24.15+)
```sh
npm install --prefix apps/web
npm install --prefix apps/api
npm run start --prefix apps/api
npm run start --prefix apps/web
```
API: http://localhost:3000/api/health; web: http://localhost:4200.
Na versão inicial, o blog ainda não tem persistência nem autenticação; o painel é somente uma prévia visual. **Não implantar em produção.**

## Qualidade e integração
A CI obtém o `Data_libray` com commit fixado e executa seu SAC-PRE001 + build Angular oficial + SAC-P001 usando comprovante efêmero assinado. Veja `docs/SAC.md`.
Dependências ainda precisam de lockfiles versionados: a CI gera lockfiles temporários como artefatos para inspeção; isso é etapa de bootstrap, não garantia de build reprodutível.

Nenhum código neste commit altera a VPS, banco em produção ou a branch `main`.

