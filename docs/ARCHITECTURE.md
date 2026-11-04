# Arquitetura aprovada — fase 1

## Topologia
Caddy existente -> Angular (site público / painel futuro) -> /api -> NestJS -> PostgreSQL 18 existente, **novo database blog_cms e usuário restrito**.
Aplicações, volumes e banco não devem ser compartilhados entre projetos. O Caddy existente será reutilizado, sem Cloudflare Pages.
A comunicação entre web e API usará a mesma origem em produção. Não habilitar CORS global.

## Frontend
Somente `apps/web` em Angular; sem React, PHP ou sites TypeScript paralelos.
Angular 22 com TypeScript 6 estrito. Site público inicialmente CSR; SSR/prerender de artigos será acrescentado antes de colocar o blog público em produção para SEO.
O módulo /admin nesta etapa é uma prévia sem gravações nem operações administrativas. Antes da implantação, acrescentar autenticação e guardas no Angular **e autorização no NestJS**, não apenas proteção de rota.

## Backend
NestJS 11, uma API REST única, com entradas validadas e operações de banco isoladas. Endpoints de escrita só serão criados quando autenticação, RBAC, proteção CSRF/sessões e testes estiverem prontos.
Nunca executar migrations automaticamente no boot da API. Conexão ao banco, credenciais e mídia por variáveis/volumes externos.

## Persistência
Schema inicial em `database/migrations/001_initial.sql`; migração não aplicada. UUIDs gerados pela aplicação; conteúdo estruturado em JSONB, renderizado com sanitização para evitar XSS. Mídia em volume persistente com metadados no banco.

## Fases
1. Fundamento e integração SAC (esta branch).
2. Auth, sessões seguras, RBAC e banco com migrations testadas.
3. Editor rich-text Tiptap com rascunhos, versionamento e mídia.
4. Publicação, SEO, pré-renderização/SSR e painel mobile.
5. E2E Playwright/Guardian com cenários reais; Docker sem privilégios, limites e deploy VPS.

