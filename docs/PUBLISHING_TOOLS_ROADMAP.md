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
