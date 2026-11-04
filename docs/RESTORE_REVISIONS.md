# Restauração de revisões — arquitetura isolada

## Regra de negócio
O novo caso RestoreHistoricalDraft recupera conteúdo antigo como uma NOVA revisão de rascunho.
Não regrava histórico, não altera diretamente artigos publicados, agendados ou arquivados.
Autor só restaura versões de seu próprio rascunho. Editor e administrador podem atuar em rascunhos.
Autorização ocorre antes do acesso a snapshots privados.

## Segurança dos dados
O registro histórico é validado em runtime por isVerifiedEditorialRevision:
origem da alteração, id, autor, número da revisão, datas, campos esperados e documento JSON v1.
Restaurar copia apenas title, slug, excerpt e body. Post ID e autor são preservados.
O status fica draft; scheduledAt e publishedAt ficam nulos.
Uma nova revisão é criada e nunca reutiliza o número histórico.
Origem da revisão nova é user + actor.id confiável, NUNCA campo fornecido pelo cliente.

## Porta transacional futura
RestoreDraftStore ainda não possui adaptador SQL ou implementação persistente.
A operação restoreDraft(next, expectedRevision, origin) deverá garantir:
1. UPDATE condicional com status=draft e revisão esperada.
2. INSERT de snapshot de auditoria com a revisão nova e identidade autenticada.
3. UPDATE e INSERT na MESMA transação, com ROLLBACK de ambos se falhar.
4. Erros de slug duplicado e concorrência retornam códigos distintos.
5. Nunca sobrescrever outra edição concorrente e nunca apagar revisões antigas.

## Testes
Treze novos testes isolados verificam recuperação, autorização, preservação de histórico,
corridas entre editores, integridade do snapshot, erro de slug e falha simulada
na gravação de auditoria. Isto NÃO prova transações reais no PostgreSQL.

## Ordem definida
Arquitetura do domínio -> autenticação e serviços internos -> editor Angular ->
testes unitários e navegador -> integrações e PostgreSQL real por último -> homologação -> deploy.
Sem novos endpoints administrativos, cron, conexão à VPS, PR, merge ou deploy.
Data_libray/SAC permanece no CI e não autoriza implantação.
