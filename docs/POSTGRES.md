# PostgreSQL — integração somente leitura (fase 2)

## Comportamento
- `GET /api/health`: confirma apenas processo HTTP ativo. **Não certifica o banco**.
- `GET /api/public/posts`: busca até 30 artigos cujo estado é `published` e a data já passou, ordenados do mais recente para o mais antigo.
- Banco ausente/indisponível: **HTTP 503**; não inventa artigos vazios.
- `/admin` continua apenas prévia; sem login, sem escrita e sem endpoints administrativos.

## Configuração para testes fora da VPS
Criar um banco **exclusivo**, aplicar `database/migrations/001_initial.sql` manualmente sob credenciais com privilégio suficiente e fornecer `DATABASE_URL` fora do Git:
```sh
DATABASE_URL='postgresql://USUARIO:SENHA@HOST:5432/blog_cms' npm run start --prefix apps/api
```
Exemplo ilustrativo, não são credenciais reais. Em ambiente Docker, usar hostname privado da rede de containers e usuário de banco restrito. Não conectar o CMS ao banco de outro projeto nem expor PostgreSQL na internet.

## Recursos
O pool limita conexões a 3 por processo, com timeout de conexão de 3s. Em uma VPS com 4 GB RAM, medir recursos antes de criar novos containers.

## Segurança
API pública não recebe SQL, filtro ou ordenação fornecidos pelo visitante. O backend não retorna hash de senha, corpo dos rascunhos ou conteúdos de futuro. O conteúdo rico será validado e sanitizado antes de ser exibido.

## Validação
`npm test --prefix apps/api` cobre ausência de banco, falhas de conexão, resultado vazio e consulta parametrizada/SQL fixo. Ainda faltam testes de integração contra PostgreSQL real, autenticação, fluxo de publicação, Guardian e deploy. Não iniciar produção antes desses gates.

## Persistência editorial transacional — banco descartável da CI

`PgEditorialRepository` implementa a porta de criação, leitura e
compare-and-save. Ele NÃO está registrado no módulo HTTP NestJS, pois
login, sessão, CSRF/Origin e RBAC do adaptador HTTP ainda não existem.
Apenas o domínio controla se o ator pode editar ou publicar.

O job CI cria serviço isolado **PostgreSQL 18**, database `blog_cms_ci`,
aplica a migração inicial `001_initial.sql` e a proposta
`002_editorial_storage_draft.sql` **somente nessa base vazia**.
O teste recusa nomes de banco que não sigam o padrão de CI, recusa host
remoto e recusa banco com tabelas preexistentes. Nenhum SQL é executado
na VPS. `002` continua em `database/proposals` (não promovido a
migration de produção).

Testes: criação e snapshot revision 0 em um COMMIT, duplicidade de slug,
concorrência real de duas gravações, edição não autorizada, rollback
provocado por constraint na tabela de revisões, histórico do editor,
publicação autorizada e leitura pelo serviço público. Não são cenários
de browser nem prova de login HTTP.
