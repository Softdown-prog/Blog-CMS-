# Tipografia do editor — fonte, tamanho e estilo por bloco

O editor Angular do Blog CMS permite alterar a **tipografia de cada bloco de texto**,
sem modificar o visual global dos controles administrativos.

## Controles
Em cada parágrafo, subtítulo, citação ou lista:
- **Fontes locais:** padrão do sistema, Arial, Georgia, Verdana e monoespaçada.
- **Tamanho:** pequeno, normal, grande, muito grande.
- **Alinhamento:** esquerda, centro ou direita.
- **Ênfase:** negrito e itálico (independentes).

Os controles aparecem imediatamente na prévia e as alterações passam a contar
como conteúdo não salvo, respeitando os avisos de navegação da main.
Salvar rascunho grava a configuração no mesmo JSONB do artigo, junto com a
revisão e o histórico já existentes. Publicar usa exatamente os mesmos blocos.

## Contrato
O documento continua como \`schemaVersion: 1\`. Cada bloco textual pode ter a
propriedade **opcional** \`typography\`:

\`\`\`json
{
  "type": "paragraph",
  "text": "Texto de exemplo",
  "typography": {
    "font": "georgia", "size": "large", "align": "center",
    "bold": true, "italic": false
  }
}
\`\`\`

Sem \`typography\`, o bloco preserva seu formato legado. Com \`typography\`,
todos os campos listados são obrigatórios; propriedades desconhecidas são
rejeitadas pelo parser. O bloco \`image\` nunca aceita tipografia.

Não existe HTML inserido pelo autor, CSS dinâmico, URL de fonte, carregamento
de fontes de terceiros nem atributo \`style\` com valor vindo do banco.
O backend valida a enumeração e o Angular converte cada opção em uma classe
CSS estática, também usada no conteúdo público. Fontes seguem os fallbacks do
navegador/sistema; não há garantia de que uma fonte não instalada exista.

## Limites
A formatação funciona por **bloco inteiro**, não por seleção de algumas palavras
dentro de um mesmo parágrafo. Não há editor rico com HTML, escolha de tamanho
em pixels livres, upload de fontes ou novas tabelas de banco.

## Testes
- Node: compatibilidade com artigos legados, validação rígida de formato,
  rejeição de CSS arbitrário e conversão do workbench sem perda de dados.
- Playwright Chromium (desktop e mobile emulado): alterar controles, refletir
  no CSS da prévia, salvar JSON, recarregar, exibir fonte na publicação e não
  executar HTML malicioso.
- Workflow de CI: NestJS, PostgreSQL 18, Angular AOT/SAC e testes de navegador.

PR independente do agendamento automático. Sem merge nem deploy.
