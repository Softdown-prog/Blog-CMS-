# Catálogo paginado de rascunhos (NestJS + Angular)

## Problema
`GET /api/admin/editorial/drafts` retorna apenas os 50 rascunhos mais recentes.
O editor Angular não conseguia localizar trabalhos mais antigos sem o ID do rascunho.

## Contrato adicionado
`GET /api/admin/editorial/drafts/catalog?q=angular&kind=all&page=1`

- Exige sessão ativa e permissão `list-posts`; a consulta executada no
  PostgreSQL filtra **autor** antes de aplicar busca/paginação.
- Busca literal e sem diferenciação de maiúsculas/minúsculas em **título e slug**.
  `%`, `_` e barras invertidas não são curingas SQL.
- `kind`: `all` (padrão), `post` ou `page`.
- `page`: inteiro de 1 a 10.000, padrão 1.
- `q`: string opcional com até 80 caracteres; espaços externos são removidos.
- Campos extras, valores inválidos ou formato suspeito: HTTP 400.
- Resposta: `{ "items": [DraftSummary, ...], "nextPage": 2 }`,
  sendo `nextPage: null` quando terminou; entrega até 20 linhas por página.
- Ordenação: `updated_at DESC, id DESC`. Busca, filtros e paginação são
  aplicados **no servidor**, nunca a uma fatia local dos 50 recentes.
- `Cache-Control: no-store`; nenhum conteúdo ou título de outro autor deve
  aparecer para a função `author`. Editores e administradores mantêm
  a visão permitida pelas políticas existentes.

O endpoint legado `GET .../drafts` mantém o formato de **array e limite 50**
para evitar regressão em clientes antigos. Somente o editor Angular usa
`/drafts/catalog` como nova fonte de resultados.

## Interface
No painel **Meus rascunhos** é possível pesquisar, escolher entre Postagens
e Páginas e carregar mais resultados. Uma consulta nova volta à página 1.
O botão **Carregar mais** mantém os filtros aplicados na última pesquisa
e elimina IDs duplicados do conjunto exibido. A seleção de um rascunho
continua recuperando o corpo completo por `GET /drafts/:id` e respeitando
o aviso para edições não salvas.

## Limites
A paginação por páginas utiliza `OFFSET` e pode sofrer deslocamentos caso
muitos rascunhos sejam editados durante a navegação. Uma futura paginação
por cursor poderá eliminar essa limitação se houver volume ou concorrência
suficientes para justificá-la. Os filtros não consultam o conteúdo do corpo,
apenas título e slug.

Sem migrações ou alterações de tabelas. Não há autossalvamento nem deploy.

## Validação
CI executa testes de integração real PostgreSQL 18/NestJS com **mais de 50
rascunhos** para conferir paginação, permissões por autor, busca com caracteres
literais, parâmetros inválidos e ausência de respostas cacheáveis. Playwright
executa testes de Angular no Chromium desktop e mobile emulado: paginação
além de 50, filtros, reabertura e tratamento de erro.
