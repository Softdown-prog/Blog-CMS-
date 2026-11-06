# Ferramentas de escrita — Blog CMS

## Escopo

Ferramentas reais no editor Angular em `/admin` sem segundo editor,
sem plugin externo e **sem mudar o formato JSONB/SQL** do post.

- **Reorganizar blocos:** botões Subir/Descer mantêm o identificador
  local e preservam texto, tipo e nível H2/H3.
- **Duplicar blocos:** cria uma cópia imediatamente após o original,
  com novo ID. O limite canônico permanece em 200 blocos.
- **Localizar/Substituir:** busca literal e sem distinção de maiúsculas
  nos textos de parágrafos, títulos de seção, listas e citações.
  A substituição é global somente no corpo; título do post, URL,
  resumo e descrições de imagens não são modificados.
- **Desfazer/Refazer:** histórico limitado às últimas 50 alterações
  locais em título, endereço, resumo, tipo e blocos. Digitações
  consecutivas no mesmo campo em até 850 ms são agrupadas.
  O histórico nunca é armazenado no servidor ou no localStorage.

## Segurança e persistência

A substituição escapa metacaracteres de expressão regular (busca
**literal**, não executa uma expressão enviada pelo usuário);
limita busca a 80 caracteres, reposição a 500 e até 500 ocorrências
por operação. O documento produzido é validado com
`workbenchDocument` / `parseEditorialDocument` **antes** de substituir
o estado Angular. Se a edição extrapola os limites, o conteúdo
original permanece na bancada e aparece um alerta.

O conteúdo HTML digitado é sempre exibido como texto.
O salvamento e a publicação continuam sujeitos ao
`EditorialCommands` / `PgEditorialRepository`, autenticação,
CSRF, revisão otimista e botões explícitos existentes.
Mover/duplicar/substituir **não envia requisições** automaticamente.

Ao abrir outro rascunho, iniciar texto novo ou recarregar a página,
o histórico de desfazer/refazer é reiniciado; o conteúdo já salvo
continua recuperável pelo ID/URL. Após publicar, as ferramentas de
histórico e substituição ficam bloqueadas.

## Testes

Os testes puros verificam limites, reordenação, identidade dos blocos,
substituição literal, múltiplos blocos, HTML escapado e entradas
inválidas. Playwright em Chromium desktop e mobile verifica
operações, histórico, saída segura, acessibilidade dos controles,
ausência de overflow e salvamento do documento v1 pela API
já integrada. O teste de navegador simula respostas HTTP; não
substitui os testes HTTP/PostgreSQL existentes.

Não altera migrations nem executa deploy na VPS.
