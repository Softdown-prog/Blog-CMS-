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
