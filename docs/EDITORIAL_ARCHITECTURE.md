# Núcleo editorial do CMS — contrato inicial v1

## Fronteiras arquiteturais
O domínio \`apps/api/src/editorial/\` é TypeScript puro: **não importa** Angular, NestJS, Tiptap, PostgreSQL ou Data_libray. Ele define o contrato de conteúdo e as regras de autorização/transição. Não há endpoints administrativos, jobs de agendamento, eventos externos nem gravação no banco nesta fase.

\`\`\`text
Angular (futuro editor) -> NestJS (API e validação)
                                   |
                                   v
                         Política editorial pura
                          /                \
                  documento v1          transições
                                   |
                                   v
                          Porta de repositório
                                   |
                                   v
                     PostgreSQL (implementação futura)
\`\`\`

A rota pública atualmente implementada em \`posts.service.ts\` continua isolada dessa arquitetura. Antes de habilitar a administração, precisamos colocar políticas no serviço de aplicação e confirmar permissões no servidor, nunca só no Angular.

## Documento canônico no campo JSONB
Formato \`{ "schemaVersion": 1, "blocks": [...] }\`. Blocos permitidos agora:
- \`paragraph\`: somente texto literal, até 5.000 caracteres.
- \`heading\`: níveis 2 ou 3, até 180 caracteres.
- \`quote\`: somente texto literal, até 2.000 caracteres.
- \`list\`: até 40 strings, cada uma de até 350 caracteres.
- \`image\`: \`mediaId\` UUID + \`alt\` até 180 caracteres; nunca URL externa arbitrária.

Até 200 blocos e 100.000 unidades de texto no total. Campos desconhecidos, versões não previstas, iframes e HTML bruto são rejeitados na entrada. Isso **não é sanitização automática da saída**: o Angular deverá escapar interpolação; não utilizar \`innerHTML\`. Tiptap será adaptador de entrada/saída, não a fonte da verdade. Links, negrito, listas ordenadas e formatos avançados exigirão nova versão de contrato + testes de migração.

Não salvar HTML bruto do editor no banco. Imagens só por referência a mídia validada posteriormente por autorização de uso e armazenamento confiável.

## Estados e transições
| Estado atual | Ações permitidas | Estado resultante |
| --- | --- | --- |
| draft | edit, schedule, publish, archive | draft, scheduled, published, archived |
| scheduled | edit, schedule, unschedule, publish, archive | scheduled, draft, published, archived |
| published | edit, archive | published, archived |
| archived | restore | draft |

Um \`schedule\` exige timestamp ISO UTC no futuro; o domínio agora utiliza \`scheduledAt\` distinto de \`publishedAt\`, e a proposta 002 prevê coluna \`scheduled_at\`. **Não há publicador automático**: a promoção de scheduled para published exigirá mecanismo e testes separados. \`publish\` direto usa instante do servidor como data de publicação; \`archive\` limpa o agendamento e conserva data efetiva anterior, quando houver; \`restore\` reinicia sem data.

### Perfis
- \`author\`: editar/arquivar **somente** o próprio rascunho.
- \`editor\`: operar publicações, agendamentos e revisões.
- \`admin\`: mesmas operações editoriais, além da futura gestão de usuários/permissões (não implementada).

A política recebe \`actor\` **autenticado pela camada futura**. O usuário não pode fornecer role/actor arbitrário pela API. \`expectedRevision\` evita aceitar decisão obsoleta; o serviço futuro precisa usar **compare-and-swap transacional** no banco (UPDATE com WHERE revision = expectedRevision, incremento e registro de revisão na mesma transação). Nesta etapa só produz decisão pura, sem salvar nada.

### Regras de publicação
Título não vazio até 240 caracteres, slug ASCII minúsculo com hífens simples até 100, resumo até 500, documento v1 validado e pelo menos um bloco com conteúdo não vazio. O slug exclusivo é garantido futuramente pela constraint do PostgreSQL. A regra de conteúdo não afirma qualidade editorial.

## Cenários de teste automatizados
Validação negativa de schema, HTML não confiável, campos indevidos, limites e imagens; autor sem permissão, revisão divergente, agendamento fora do futuro, publicação incompleta, arquivo/restauração e ausência de efeitos colaterais.

## Pendências **antes de qualquer integração ou deploy**
1. Contratos de casos de uso: CreateDraft, UpdateDraft, Publish, Schedule, ListAdmin, Media.
2. Serviço transacional NestJS + repository port, sessão autenticada e RBAC.
3. Versionamento real em \`cms_posts\` e revisões consistentes; migração 001 ainda não contempla \`revision\`.
4. Escolha/integração do editor Tiptap, mapeamentos e testes de XSS.
5. Testes de integração isolados com PostgreSQL e Guardian/Chromium; acessibilidade Android.
6. SEO, páginas públicas, logs sem dados sensíveis, observabilidade e limites de recursos.

O Data_libray/SAC existente deve continuar validando o build; não acoplar a biblioteca ao domínio. Nenhum deploy, provisionamento de banco ou criação de PR/merge nesta etapa.
