# Ebooker

Editor de um ebook por vez, feito com HTML, CSS e JavaScript. Abre uma pasta existente com a **File System Access API**, edita os arquivos Markdown originais e mostra uma prévia HTML com **Marked.js** e **DOMPurify**. Não cria livros, capítulos ou sessões.

## Abrir o editor

Use **Chrome ou Edge atualizado**. A abertura e a gravação de pastas precisam de um contexto seguro: `localhost` ou HTTPS. Firefox e Safari não oferecem o seletor de pastas com escrita necessário para este app.

Na pasta do projeto:

```powershell
npm start
```

Abra **http://localhost:4173**. Também é possível iniciar pela tarefa **Ebooker: iniciar editor** do VS Code.

O Node.js serve somente os arquivos estáticos durante o desenvolvimento. Ele não recebe, lê ou grava os ebooks. A aplicação em si é apenas HTML/CSS/JS e pode ser servida por qualquer servidor estático em localhost ou HTTPS.

As bibliotecas já estão em `vendor/`; não é necessário instalar pacotes para iniciar o editor. Depois de atualizar dependências, execute `npm install` e `npm run vendor` para regenerar essas cópias. As licenças estão junto das bibliotecas.

## Estrutura esperada

Extraia o ZIP e selecione **a pasta do ebook**, com esta estrutura:

```text
Meu ebook/
  index.md                  Sobre o livro
  01/                       Capítulo
    index.md                Opcional: apresentação do capítulo
    01/
      index.md              Sessão
    02/
      index.md              Sessão
  02/
    01/
      index.md
```

- A apresentação da raiz e todos os `index.md` de capítulos e sessões são editáveis.
- Capítulos sem `index.md` mostram uma lista de suas sessões, sem inventar ou criar um arquivo.
- A navegação ordena pastas numericamente e usa o primeiro título Markdown como rótulo. Quando a primeira sessão começa com “Capítulo”, seu título também identifica o grupo.
- Pastas ocultas e pastas sem `index.md` nem sessões válidas não aparecem na navegação.
- A busca filtra títulos e nomes de pastas. Não pesquisa o conteúdo integral dos arquivos.
- O botão **ABRIR EBOOK** permanece no topo para trocar de livro.

## Edição e salvamento

- Edite à esquerda; a prévia à direita acompanha as alterações.
- O rodapé mostra palavras, caracteres e a duração estimada de leitura em segundos inteiros, atualizada durante a edição. O cálculo usa 150 palavras por minuto: `Math.ceil((palavras / 150) * 60)`, arredondando para cima quando houver uma fração.
- A lateral mostra a duração total do ebook após a quantidade de capítulos e sessões, e a duração abaixo do título de cada capítulo e sessão. Os cabeçalhos e cartões de sessões também mostram a duração. Os totais incluem as apresentações e as sessões, somam as palavras antes de arredondar e acompanham a edição; descartar alterações restaura a duração do conteúdo salvo.
- Use a barra de formatação ou escreva Markdown diretamente. Tabelas, listas de tarefas e blocos de código são suportados.
- **Salvar** ou **Ctrl+S** (Cmd+S no macOS) grava somente o arquivo selecionado. **Não há salvamento automático.**
- Antes de navegar ou trocar de livro, escolha salvar, descartar ou continuar editando.
- Ao fechar/recarregar com alterações pendentes, o navegador pede confirmação. Os rascunhos não são armazenados após o fechamento.
- O app lembra no armazenamento local do navegador a pasta do último ebook e o último capítulo/sessão selecionado. Ao reabrir ou recarregar, restaura esse conteúdo se a permissão de acesso ainda estiver concedida. Se o navegador pedir autorização novamente, use **ABRIR EBOOK** para concedê-la.
- Arquivos devem estar em UTF-8. O editor preserva BOM e o padrão CRLF de arquivos Windows ao salvar.
- O editor verifica se o conteúdo do arquivo mudou no disco antes da gravação. Em caso de conflito, não sobrescreve: copie seus ajustes e reabra o ebook para carregar a versão atual. Essa verificação não substitui backup ou coordenação com outros editores.
- Mudanças estruturais feitas por fora são carregadas ao abrir novamente a pasta.

## Prévia e privacidade

Nenhum ebook é enviado para um servidor. Marked.js e DOMPurify são carregados localmente. HTML ativo é removido da prévia; imagens externas não são carregadas automaticamente.

Imagens relativas dentro da pasta do ebook são resolvidas pela API de arquivos. Caminhos relativos são calculados a partir do Markdown selecionado; caminhos começando com `/` partem da raiz do ebook. Links para outros `index.md` disponíveis e âncoras de títulos funcionam na prévia. Links externos HTTP/HTTPS e `mailto:` só abrem quando clicados.

A rolagem sincronizada é proporcional, pode ser desativada e não representa um alinhamento exato por linha. No desktop os painéis ficam lado a lado; em telas pequenas ficam empilhados.

## Testes

```powershell
npm install
npm test
```

Os testes usam Playwright com **Edge instalado**, iniciam seu próprio servidor em uma porta livre e usam arquivos temporários no armazenamento privado do navegador (OPFS). Verificam navegação, gravação com handles reais, persistência após reabertura, conflitos externos, confirmação de alterações, BOM/CRLF, sanitização, imagens, links, formatação e responsividade. Nenhum teste modifica o ebook original.

Para incluir um ebook real na validação, defina `EBOOK_SAMPLE_PATH` com a pasta extraída antes de `npm test`. Esse teste lê todos os `index.md`, copia seu conteúdo para o armazenamento isolado do navegador e percorre os arquivos no editor, sem modificar a origem.
