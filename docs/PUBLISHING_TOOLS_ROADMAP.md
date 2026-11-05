# Ferramentas de publicação — pesquisa e plano técnico

## Princípio

Construir um CMS útil para publicar textos e imagens, não apenas um backend de
logs. Interfaces Angular mobile-first, domínio TypeScript estrito e backend
NestJS. Manter componentes pequenos e independentes, sem duplicar frontends.
Postagem só muda através dos comandos editoriais já existentes, com RBAC,
revisão otimista e eventual integração PostgreSQL **por último**.

## Pesquisa sobre funcionalidades de referência

Blogger / Blogspot:
- Editor de postagem com rascunho, prévia e publicação.
- Marcadores para organizar e filtrar postagens.
- Agendamento e links permanentes personalizados; configurações de SEO.
Referências oficiais:
- https://support.google.com/blogger/answer/154172?hl=pt-BR
- https://support.google.com/blogger/answer/41373?hl=pt-BR

WordPress / Gutenberg:
- Editor em blocos, painel de configurações do post e biblioteca de mídias.
- Estrutura/outline, contagem de palavras e estimativa de tempo de leitura.
- Categorias, tags, imagem destacada, prévia e agendamento.
Referências oficiais:
- https://wordpress.org/documentation/article/wordpress-block-editor/
- https://developer.wordpress.org/block-editor/

Não copiar dependências pesadas nem implementar compatibilidade com plugins
WordPress. Reproduzir apenas os fluxos úteis com nosso contrato JSON v1.

## Fase 1 — já iniciada (domínio puro)

Arquivo: apps/api/src/editorial/publication-tools.ts

Função reviewPublication(): recebe somente campos do rascunho e devolve:
- sugestão de slug determinística (não substitui a URL atual);
- sugestão de resumo a partir do primeiro parágrafo;
- contagem de palavras e estimativa de leitura;
- outline de headings com posição no documento;
- quantidade de imagens e indicação do bloco sem alt;
- avisos consultivos para título/resumo longos, slug inválido,
  documento inválido, texto vazio, artigo curto e ausência de headings.

É uma análise read-only: **não salva**, não publica e não altera revision.
Avisos de SEO não garantem classificação em buscadores, não bloqueiam a
publicação e não substituem a política de autorização da API.
Imagens usam mediaId e alt do documento canônico; ainda não existe galeria
real nem upload.

## Fase 2 — ferramentas no Angular (planejado, não implementado)

- Editor visual de blocos v1: parágrafo, H2/H3, listas, citação, imagem.
- Painel lateral de revisão editorial: título, resumo, slug e avisos.
- Prévia responsiva de post em desktop/mobile com texto escapado.
- Salvar rascunho, indicar mudanças pendentes e histórico de revisões.
- Comandos de formatação touch-friendly para Android, navegação por teclado
  e acessibilidade. Nenhuma escrita sem autenticação/CSRF.

## Fase 3 — gestão de publicações (planejado)

- Marcadores/tags e categorias (precisam de schema versionado e migrations);
- Biblioteca de mídias (uploads, formatos, tamanho, alt, autoria, direitos);
- Imagem de capa, descrição de busca, social preview, canonical e noindex;
- Agendador e calendário editorial (backend já tem contratos, sem worker real);
- Busca/filtros por autor, título, estado, período, categoria e tag;
- Templates de post e blocos reutilizáveis, links internos e redirecionamento
  de permalink com controle de colisão;
- Checklist opcional pré-publicação e checagem de links acessíveis, sem crawler
  remoto automático nesta etapa.

## Regra de integração por último

Primeiro contratos e testes unitários; depois interface Angular e testes de
browser/Android; somente após isso conectar autenticação HTTP, PostgreSQL,
mídias e agendador. Testes de publicação devem cobrir permissão, revisão,
XSS, upload malicioso, links inseguros, cache e acessibilidade.

Não houve migração de banco, login HTTP, integração com o WordPress/Blogger,
serviço de SEO, hospedagem, PR, merge ou deploy.

## Fase 2A — bancada editorial Angular (implementada na branch)

A rota já existente `/admin` continua sendo uma **demonstração pública sem
autenticação e SEM persistência**. O componente
`apps/web/src/app/admin-preview.component.ts` foi transformado em uma
bancada de escrita local com template e CSS separados.

- Campos editáveis: título, endereço (slug) e resumo;
- Blocos locais: subtítulo H2/H3, parágrafo, lista e citação, com adição/remoção;
- Sugestões explícitas de slug e resumo; aplicar sugestão só altera o signal;
- Painel lateral com contagem de palavras, minutos, imagens, avisos e outline;
- Prévia com opções celular/desktop e **interpolação escapada**, jamais innerHTML;
- Android/mobile-first: CSS responsivo, controles touch-friendly e labels;
- Estado exclusivo em signals Angular; recarregar a página elimina os dados;
- Modo de escrita demonstrativo **não possui salvar/publicar/logout/upload**.

`apps/api/src/editorial/editor-workbench.ts` é um pequeno adaptador puro de
blocos de UI para o mesmo documento JSON v1 validado pelo domínio;
o Angular **reutiliza o código puro de `apps/api/src/editorial`**, sem
copiar regras. Se esse vínculo de diretórios começar a criar dependência
de infraestrutura, extrair somente o domínio puro para pacote workspace
compartilhado (não antecipar uma migração maior agora).

A compilação Angular AOT/SAC e os testes unitários do domínio precisam passar.
Testes reais de interação no Chromium/Playwright, teclado e Android,
persistência autenticada e revisão de acessibilidade permanecem pendentes.

**Escopo futuro ainda não realizado:** upload de mídias, tags, categorias,
editor completo com seleções/rich text, salvamento, autenticação HTTP,
e publicação em banco.

## Fase 2B — testes reais de navegador (Chromium + Playwright)

- Adicionados `apps/web/playwright.config.ts` e `apps/web/e2e/editor.spec.ts`.
- O Playwright utiliza **o build Angular oficial** do SAC, servido apenas em
  127.0.0.1:4173 por `scripts/serve-web.mjs` (servidor estático mínimo).
- Dois projetos: Chromium desktop e Chromium com perfil **Pixel 5 emulado**
  (não equivale a testar um dispositivo Android físico).
- Cenários: edição, sugestões de slug/resumo, contagem de palavras e H3,
  criação/remoção de lista e citação, conteúdo inválido, payload XSS tratado
  como texto, abrir/fechar prévia, navegação por teclado, ausência de requests
  de escrita/API, perda de estado após recarregar e overflow horizontal.
- Workflow roda em runner descartável: `npm run test:e2e --prefix apps/web`.
  Inclui logs, screenshots e traces apenas em caso de falha.
- `main` agora também dispara verificações de CI em novos pushes;
  **isso não ativa nenhum deploy**.

Pendências após esta etapa: checagem em Android físico, acessibilidade com
leitor de tela, múltiplos tamanhos intermediários, atalhos de teclado,
persistence/auth HTTP, upload de mídia e banco. Não presumir que compilar e
passar no Playwright garantam prontidão para produção.
 
## Fase 2C — taxonomia e marcadores em memória

O contrato isolado `apps/api/src/editorial/publication-taxonomy.ts`
representa **uma categoria opcional** e **até 12 tags** em nomes legíveis.
Inclui normalização Unicode, limites, campos exatos, deduplicação por
acentos/maiúsculas, rejeição de controles e delimitadores de HTML e erros
tipados. Não altera `EditorialPost` nem `EditorialDocumentV1`.

A bancada Angular agora oferece escolha de categoria demonstrativa,
adição/remoção de marcadores, avisos de duplicidade e exibição na prévia.
Os valores são guardados apenas em signals e apagados ao recarregar.
Os testes Playwright continuam em Chromium desktop e Pixel 5 emulado.

**Não há categorias reais no banco, relação com posts, permalinks únicos,
autenticação ou endpoints.** Antes de persistir, definir tabela normalizada
de termos, aliases/slugs, relações post-termo e autorização/RBAC com
compare-and-swap de revisão. Nunca confiar apenas na lista de categorias
da interface.
