# Proteção contra perda de edições no editor Angular

## Problema
O editor do Blog CMS só confirmava descarte no botão **Novo texto**
e na troca de rascunho. Navegar pelo menu, entrar em **Páginas e widgets**
ou encerrar a sessão podia descartar alterações do texto sem aviso.
Além disso, a primeira bancada contém texto de demonstração,
mas abrir **Novo texto** disparava um aviso de mudanças não salvas.

## Implementação
- O editor Angular mantém uma assinatura inicial para título, URL, resumo,
  tipo de conteúdo e blocos — **separada** da assinatura da última versão
  salva no banco. O estado inicial exemplificativo não gera aviso falso.
- A rota `/admin` usa `canDeactivate` consultando o componente
  real de escrita por `viewChild`, e confirma saídas com mudanças pendentes.
- O navegador recebe `beforeunload` para tentar avisar ao recarregar,
  fechar aba ou sair pelo botão nativo. Alguns navegadores Android não
  garantem esse diálogo: é proteção complementar, não autossalvamento.
- O logout exige confirmação **antes** de revogar a sessão. Cancelar não
  envia POST; aceitar não exibe segundo diálogo ao navegar para o login.
- **Novo texto** e **abrir outro rascunho** reutilizam a mesma decisão.
- Ao salvar, a assinatura de referência avança somente quando a API responde
  com sucesso; se o usuário editar novamente durante a requisição, a nova
  alteração continua marcada como pendente.
- Abrir outro rascunho, restaurar uma revisão ou confirmar a publicação
  atualiza a assinatura de referência sem mexer no histórico PostgreSQL.

## Limites
A proteção acompanha os **campos editoriais persistíveis**. Categorias,
tags, capas e ajustes do catálogo demonstrativo continuam em memória e
não são salvos pelo backend; esta correção não torna esses campos
persistentes. Não há uso de localStorage, fila offline, novo banco
ou alteração de domínio.

## Verificação
Playwright em Chromium desktop e mobile emulado confirma navegação sem
diálogo falso, rejeição/aceitação do descarte, logout sem revogação após
cancelamento, um único logout após confirmação, salvar pela API real
simulada e sinalização de `beforeunload`.
A suíte existente do CMS continua no pipeline com Angular AOT/SAC,
NestJS e PostgreSQL 18 descartável.

Não há migração, merge automático ou deploy na VPS.
