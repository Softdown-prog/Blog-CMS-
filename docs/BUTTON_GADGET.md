# Gadget nativo de botões — links e dicas de hover

## Recursos

Um widget `buttons` foi adicionado ao gerenciamento de widgets existente.
Em `/admin/site`, o administrador pode ativar o widget, definir título e
posição; no mesmo cartão, adicionar até **12 botões individuais**, editar,
mudar a ordem, desativar ou excluir.

Cada botão possui texto visível (1–80 caracteres), descrição opcional
de hover/foco (até 160 caracteres), link interno ou externo (até 500),
posição de 0 a 100 e estado habilitado.

O site exibe apenas botões habilitados, ordenados por posição e ID. O
gadget não aparece quando desativado ou sem botões habilitados.
O texto de hover aparece também ao focar pelo teclado; em dispositivos
touch é exibido como texto auxiliar, sem depender de `:hover`.
Links externos são abertos em outra aba com
`rel="noopener noreferrer"`; internos usam o endereço original.

## API

Usa as sessões existentes com cookie HttpOnly, RBAC de administrador,
cabeçalho `X-CMS-CSRF` e verificação de `Origin` nas escritas.

| Método | Endpoint | Finalidade |
|---|---|---|
| GET | `/api/admin/site/buttons` | Listar todos |
| POST | `/api/admin/site/buttons` | Criar |
| PATCH | `/api/admin/site/buttons/:id` | Alterar |
| DELETE | `/api/admin/site/buttons/:id` | Excluir |
| GET | `/api/public/widgets` | Inclui `buttons: []` nos widgets exibidos |

A validação do servidor rejeita `javascript:`, `data:`, URL relativa
sem barra, URL com usuário/senha, barras invertidas e endereço
começando com `//`. Aceita `/pages/manual`, `/posts/exemplo`,
`https://example.com` e `http://example.com`. O texto de hover e
o rótulo são interpolados como **texto**, nunca HTML executável.

## Banco de dados

`database/proposals/005_button_gadget_draft.sql` altera
exclusivamente a restrição de tipos de widget criada na proposta 004,
adiciona o widget `buttons` (desativado por padrão) e cria
`cms_widget_buttons`. Não muda a tabela de postagens.
A criação dos itens usa transação e bloqueio de linha do widget para
garantir o limite de 12 mesmo com criação simultânea.

**Proposta de migração, não deploy:** aplicar 005 apenas em um PostgreSQL
descartável após 001, 002 e 004 durante os testes. Antes de produção,
revisar migrações/versionamento, Caddy, contas e permissões. Não foi
executada nenhuma migração na VPS nesta alteração.

## Verificação

- Unitários: links válidos/inválidos, campos não previstos, limites,
  segurança do texto e leitura pública dos botões.
- PostgreSQL 18 de integração: persistência, ordem, ativação, remoção,
  limite de 12 sob concorrência e ausência de dados fictícios.
- HTTP NestJS: somente admin com sessão válida, CSRF e Origin pode gravar.
- Playwright desktop/mobile: cadastro, edição, exclusão, dica hover/foco,
  link interno/externo, HTML escapado e ausência de overflow.
