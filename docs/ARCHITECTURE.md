# Arquitetura do Blog CMS — evolução incremental

## Separação de responsabilidades
- \`apps/web\`: único frontend Angular (blog público e futura administração), sem backend embarcado.
- \`apps/api/src/editorial\`: domínio editorial puro e testável (formato do artigo, autorização e transições).
- \`apps/api/src/posts.service.ts\`: leitura pública atual, sem endpoints administrativos de escrita.
- \`apps/api\` (módulos futuros): casos de uso, autenticação, DTOs, repository ports e adaptadores PostgreSQL.
- \`database/migrations\`: DDL versionado, **não aplicado**.

Detalhes do contrato estão em [EDITORIAL_ARCHITECTURE.md](EDITORIAL_ARCHITECTURE.md).
A política de segurança está em [SECURITY.md](SECURITY.md).

## Decisões estáveis
1. Angular 22 + TypeScript estrito como front-end canônico; NestJS 11 na API; PostgreSQL 18 para a implantação eventual.
2. Nenhuma dependência de React, PHP, WordPress ou Cloudflare Pages.
3. Domínio independente de frameworks/banco e contrato JSONB versionado. Não persistir HTML bruto.
4. Só administradores e editores publicarão; autores gerenciam apenas seus próprios rascunhos.
5. \`draft -> scheduled -> published\` não significa publicação automática: exige processo auditável separado.
6. A API autorizará tudo novamente no servidor, com controle de revisão transacional.
7. Prioridade atual: arquitetura e testes, sem alterações na VPS, sem migrações reais, sem PR/merge.

## Hospedagem eventual (fora de escopo)
Na fase de produção, Caddy existente -> Angular -> API NestJS -> banco exclusivo na instância PostgreSQL da VPS. Reutilizar somente infraestrutura estável após testes e avaliação de RAM. Nada é provisionado agora.

## Verificação
\`npm test --prefix apps/api\` executa os testes da leitura pública e do domínio. O GitHub Actions continua usando SAC pre/build/post do Data_libray, **sem autorização de deploy**. Testes de navegador e integração real ainda precisam ser construídos.

