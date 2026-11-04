# Casos de uso editoriais — fase de arquitetura

## Escopo deste incremento

Implementados contratos internos em apps/api/src/editorial/application:
- ports.ts: porta de repositorio editorial, relogio e gerador de IDs.
- commands.ts: casos de uso para criar rascunho, editar rascunho e publicar rascunho.
- commands.spec.ts: repositorio simulado somente nos testes.

O dominio permanece independente de NestJS, Angular, Postgres, Tiptap, rede e filesystem.
Nenhum controlador de escrita, login, migração ou deploy foi criado.

## Regras dos casos de uso

CreateDraft: exige actor confiavel fornecido pelo host, valida titulo, slug e documento v1, gera ID pela porta e inicia revisao 0.

SaveDraft: busca registro existente, permite alteracao apenas em status draft, exige permissao e revisao esperada, valida corpo e incrementa revisao. Se outro editor gravou antes, retorna stale-revision.

PublishDraft: somente editor e admin, permite apenas publicar draft completo, carimba a data injetada pelo host e incrementa revisao.

O repositorio futuro deve implementar createDraft atomico com unicidade de slug e compareAndSave atomico (id + expectedRevision). Historico da revisao deve ser gravado na mesma transacao; retornar conflito quando outra escrita ganhou a corrida.

## Limites importantes

O actor nao vem do HTTP: o adaptador futuro devera obte-lo exclusivamente de sessao autenticada no servidor, com RBAC, CSRF e verificacao de identidade. Nao expor estes casos de uso via controller antes disso.

Os IDs e relogio sao injetados somente para desacoplar dependencias e permitir testes. O adaptador de producao devera usar fonte confiavel. Banco simulado nos testes nao comprova funcionamento PostgreSQL.

O fluxo de edicao atual nao altera posts publicados ou agendados, evitando alterar conteudo publico inadvertidamente. Agendamento, listagem administrativa, media, revisoes de publicados e lixeira ficam para etapas seguintes.

A migration inicial ainda nao possui coluna revision e nao foi aplicada. Antes de qualquer uso com Postgres, a migracao sera revisada e validada em banco descartavel.

## Validacao

Executar npm test --prefix apps/api para validar os casos de uso, regras de politica e leitura publica simulada.
A CI continua usando SAC do Data_libray para preflight, compilacao Angular AOT e postflight; nenhum desses testes autoriza implantacao na VPS.

## Listagem administrativa (contrato interno sem endpoints)

Novo caso `ListAdminPosts` com porta `AdminPostReader` em `apps/api/src/editorial/application/admin-list.ts`.
Editor/admin podem filtrar todos os estados; autor visualiza somente seus próprios rascunhos.
Filtro de autor é derivado do ator autenticado e aplicado na consulta de persistência; o caso de uso ainda verifica o escopo do retorno, falhando fechado diante de um adaptador incorreto.

Paginação keyset `createdAt DESC, id DESC` com 1–50 itens, padrão 20 e busca `limit+1` para detectar próxima página.
O cursor v1 usa base64url e vincula ID do ator, estado filtrado e último registro. **Não é token de autenticação nem assinatura**; pode ser alterado e nunca deve conceder acesso.
A porta deve aplicar filtros/paginação antes do limite, nunca retornar corpo do artigo e emitir somente os metadados tipados.
Resultados fora de ordem, com campos extras, fora do escopo ou acima do limite são bloqueados.

Antes de implementar o adaptador PostgreSQL: definir índices `(created_at DESC, id DESC)` e índices para autor/status, testar timestamp e UUID canônicos, alinhar migração de revision e executar testes reais em banco descartável.
Não foram criadas rotas HTTP, sessões, agendadores, integração com a VPS nem deploy.
