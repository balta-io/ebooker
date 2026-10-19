const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { chromium, expect } = require("@playwright/test");

let browser;
let server;
let baseURL;
const fixture = {
  "index.md": "# Livro de teste\n\nSobre **este livro**.\n\n[Ir para sessão](01/02/index.md#detalhes)",
  "01/01/index.md": "# Capítulo 1: Introdução\n\nPrimeira sessão.",
  "01/02/index.md": "# Segunda sessão\n\n## Detalhes\n\nConteúdo da segunda sessão.",
  "02/index.md": "# Capítulo editável\n\nApresentação do capítulo.",
  "02/01/index.md": "# Uma sessão\n\nConteúdo.",
  "10/01/index.md": "# Capítulo 10: Avançado\n\nConteúdo.",
  "assets/readme.txt": "Esta pasta não é um capítulo.",
  "01/sem-markdown/readme.txt": "Esta pasta não é uma sessão.",
};

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "tools", "serve.cjs")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseURL = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.stderr.on("data", (data) => reject(new Error(data.toString())));
    server.stdout.on("data", (data) => {
      const match = data.toString().match(/http:\/\/localhost:\d+/);
      if (match) resolve(match[0]);
    });
    server.once("exit", (code) => reject(new Error(`Servidor encerrou: ${code}`)));
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function withEditor(files, action, setup) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    if (setup) await setup(page);
    await page.goto(baseURL);
    await page.evaluate(async (entries) => {
      const storage = await navigator.storage.getDirectory();
      const root = await storage.getDirectoryHandle("Livro de teste", { create: true });
      for (const [location, content] of Object.entries(entries)) {
        const parts = location.split("/");
        let directory = root;
        for (const part of parts.slice(0, -1)) {
          directory = await directory.getDirectoryHandle(part, { create: true });
        }
        const handle = await directory.getFileHandle(parts.at(-1), { create: true });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
      }
      window.testRoot = root;
      window.showDirectoryPicker = async () => window.testRoot;
    }, files);
    await action(page);
    assert.deepEqual(errors, [], "Nenhum erro JavaScript não tratado");
  } finally {
    await context.close();
  }
}

async function open(page) {
  await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
  await expect(page.locator("#editor-view")).toBeVisible();
  await expect(page.locator("#markdown")).toBeEnabled();
}

async function diskText(page, location) {
  return page.evaluate(async (parts) => {
    let directory = window.testRoot;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return (await (await directory.getFileHandle(parts.at(-1))).getFile()).text();
  }, location.split("/"));
}

test("tema claro e escuro alterna e permanece após recarregar", async () => {
  await withEditor({}, async (page) => {
    const toggle = page.locator("#theme-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "Ativar tema escuro");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-label", "Ativar tema claro");
    assert.equal(await page.evaluate(() => localStorage.getItem("ebooker-theme")), "dark");
    assert.equal(await page.locator(".main-content").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(30, 30, 37)");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-label", "Ativar tema claro");
    await toggle.click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("ebooker-theme")), "light");
  });
});

test("abre apresentação, ordena capítulos numericamente e ignora pastas sem index.md", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await expect(page.locator("#book-meta")).toHaveText(/3 capítulos · 4 sessões · (?:[\d,.]+ minutos|menos de 1 minuto) de leitura/);
    await expect(page.locator("#document-title")).toHaveText("Sobre o livro");
    await expect(page.locator("#preview strong")).toHaveText("este livro");
    await expect(page.locator("#save")).toBeDisabled();
    assert.deepEqual(await page.locator(".chapter-row .tree-label").allTextContents(), [
      "Capítulo 1: Introdução", "Capítulo editável", "Capítulo 10: Avançado",
    ]);
  });
});

test("usa o título do frontmatter do index.md do capítulo na lateral", async () => {
  await withEditor({
    ...fixture,
    "01/index.md": "---\ntitle: Nome oficial do capítulo\n---\nTexto de apresentação.",
  }, async (page) => {
    await open(page);
    await expect(page.locator(".chapter-row .tree-label").first()).toHaveText("Nome oficial do capítulo");
    await page.locator(".chapter-row .tree-button").first().click();
    await expect(page.locator("#document-title")).toHaveText("Nome oficial do capítulo");
  });
});

test("mostra Laboratório e Quiz para aulas hands_on e quiz no menu lateral", async () => {
  await withEditor({
    "index.md": "# Livro de teste",
    "01/index.md": "# Capítulo 1",
    "01/01/index.md": '---\nlecture_type: hands_on\ntitle: "Projeto completo"\n---\n# Conteúdo do laboratório',
    "01/02/index.md": "---\nlecture_type: quiz\ntitle: Avaliação final\n---\n# Conteúdo do quiz",
    "01/03/index.md": "# Aula regular",
  }, async (page) => {
    await open(page);
    await page.locator(".chapter-toggle").first().click();
    assert.deepEqual(await page.locator(".chapter-children .tree-label").allTextContents(), [
      "Laboratório", "Quiz", "Aula regular",
    ]);
    await page.locator(".chapter-children .tree-button").first().click();
    await expect(page.locator("#document-title")).toHaveText("Conteúdo do laboratório");
    await expect(page.locator(".tree-button.active .tree-label")).toHaveText("Laboratório");
    await page.locator("#search").fill("quiz");
    await expect(page.locator(".chapter-children .tree-label")).toHaveText(["Quiz"]);
  });
});

test("rodapé mostra duração de leitura em formato adaptável e acompanha edição e troca de sessão", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator(".chapter-row .tree-button").first().click();
    await page.locator(".session-card").nth(1).click();
    await expect(page.locator("#word-count")).toHaveText("9 palavras · 58 caracteres · menos de 1 minuto de leitura");

    const editor = page.locator("#markdown");
    for (const [content, expected] of [
      ["", "0 palavras · 0 caracteres · 0 minutos de leitura"],
      [" \n\t ", "0 palavras · 4 caracteres · 0 minutos de leitura"],
      ["Olá", "1 palavra · 3 caracteres · menos de 1 minuto de leitura"],
      [Array(150).fill("a").join(" "), "150 palavras · 299 caracteres · 1 minuto de leitura"],
      [Array(151).fill("a").join(" "), "151 palavras · 301 caracteres · 2 minutos de leitura"],
      [Array(1648).fill("a").join(" "), "1.648 palavras · 3.295 caracteres · 11 minutos de leitura"],
      [Array(9000).fill("a").join(" "), "9.000 palavras · 17.999 caracteres · 1 hora de leitura"],
      [Array(9250).fill("a").join(" "), "9.250 palavras · 18.499 caracteres · 1,03 horas de leitura"],
    ]) {
      await editor.fill(content);
      await expect(page.locator("#word-count")).toHaveText(expected);
    }

    await editor.fill(fixture["01/02/index.md"]);
    await page.locator(".chapter-row .tree-button").first().click();
    await page.locator(".session-card").first().click();
    await expect(page.locator("#word-count")).toHaveText("6 palavras · 42 caracteres · menos de 1 minuto de leitura");
  });
});

test("duração de leitura total inclui apresentações e acompanha edição, descarte e salvamento", async () => {
  await withEditor({
    "index.md": "Livro",
    "01/index.md": "Capítulo",
    "01/01/index.md": "Sessão",
    "02/01/index.md": "Outra",
  }, async (page) => {
    await open(page);
    const meta = page.locator("#book-meta");
    const chapterTimes = page.locator(".chapter-row .tree-reading-time");
    await expect(meta).toHaveText("2 capítulos · 2 sessões · menos de 1 minuto de leitura");
    await expect(chapterTimes).toHaveText(["menos de 1 minuto de leitura", "menos de 1 minuto de leitura"]);
    await expect(page.locator("#document-reading-time")).toHaveText("menos de 1 minuto de leitura");

    await page.locator(".chapter-row .tree-button").nth(1).click();
    await expect(page.locator("#chapter-reading-time")).toHaveText("menos de 1 minuto de leitura");
    await expect(page.locator(".session-card .session-reading-time")).toHaveText("menos de 1 minuto de leitura");

    await page.locator(".chapter-row .tree-button").first().click();
    await expect(page.locator("#document-reading-time")).toHaveText("menos de 1 minuto de leitura");
    await page.locator(".chapter-children .tree-button").first().click();
    const content = Array(150).fill("a").join(" ");
    await page.locator("#markdown").fill(content);
    await expect(meta).toHaveText("2 capítulos · 2 sessões · 2 minutos de leitura");
    await expect(chapterTimes.first()).toHaveText("2 minutos de leitura");
    await expect(page.locator(".chapter-children .tree-reading-time").first()).toHaveText("1 minuto de leitura");
    await expect(page.locator("#document-reading-time")).toHaveText("1 minuto de leitura");

    await page.locator(".chapter-row .tree-button").nth(1).click();
    await page.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(meta).toHaveText("2 capítulos · 2 sessões · menos de 1 minuto de leitura");
    await expect(chapterTimes.first()).toHaveText("menos de 1 minuto de leitura");
    await page.locator(".chapter-children .tree-button").first().click();
    await page.locator("#markdown").fill(content);
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    await page.reload();
    await expect(meta).toHaveText("2 capítulos · 2 sessões · 2 minutos de leitura");
    await expect(page.locator("#document-reading-time")).toHaveText("1 minuto de leitura");

    await page.locator(".chapter-row .tree-button").first().click();
    await page.locator("#markdown").fill(content);
    await expect(meta).toHaveText("2 capítulos · 2 sessões · 2 minutos de leitura");
    await expect(chapterTimes.first()).toHaveText("2 minutos de leitura");
    await expect(page.locator("#document-reading-time")).toHaveText("2 minutos de leitura");
    await expect(page.locator("#word-count")).toContainText("menos de 1 minuto de leitura");
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    await page.reload();
    await expect(meta).toHaveText("2 capítulos · 2 sessões · 3 minutos de leitura");
  });
});

test("restaura a última sessão ou capítulo depois de recarregar", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator(".chapter-row .tree-button").first().click();
    await page.locator(".session-card").nth(1).click();
    await expect(page.locator("#document-path")).toHaveText("01/02/index.md");

    await page.reload();
    await expect(page.locator("#editor-view")).toBeVisible();
    await expect(page.locator("#document-path")).toHaveText("01/02/index.md");
    await expect(page.locator(".tree-button.active .tree-label")).toHaveText("Segunda sessão");

    await page.locator(".chapter-row .tree-button").first().click();
    await expect(page.locator("#chapter-view")).toBeVisible();
    await page.reload();
    await expect(page.locator("#chapter-view")).toBeVisible();
    await expect(page.locator("#chapter-title")).toHaveText("Capítulo 1: Introdução");
    await expect(page.locator(".chapter-row .tree-button.active .tree-label")).toHaveText("Capítulo 1: Introdução");
  });
});

test("capítulo sem arquivo mostra sessões; capítulo com arquivo é editável", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator(".chapter-row .tree-button").first().click();
    await expect(page.locator("#chapter-view")).toBeVisible();
    await expect(page.locator(".session-card")).toHaveCount(2);
    await page.locator(".session-card").nth(1).click();
    await expect(page.locator("#document-path")).toHaveText("01/02/index.md");
    await page.locator(".chapter-row .tree-button").nth(1).click();
    await expect(page.locator("#document-path")).toHaveText("02/index.md");
    await page.locator("#markdown").fill("# Capítulo atualizado\n\nNovo texto.");
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    assert.equal(await diskText(page, "02/index.md"), "# Capítulo atualizado\n\nNovo texto.");
    await expect(page.locator(".chapter-row .tree-label").nth(1)).toHaveText("Capítulo atualizado");
  });
});

test("salva no arquivo original e mantém o conteúdo ao reabrir", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Livro revisado\n\nUm **ajuste** importante.");
    await expect(page.locator("#preview strong")).toHaveText("ajuste");
    await expect(page.locator("#save-status")).toHaveText("Não salvo");
    await page.keyboard.press("Control+s");
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    assert.equal(await diskText(page, "index.md"), "# Livro revisado\n\nUm **ajuste** importante.");
    assert.equal(await diskText(page, "01/01/index.md"), fixture["01/01/index.md"]);
    await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
    await expect(page.locator("#markdown")).toHaveValue("# Livro revisado\n\nUm **ajuste** importante.");
    await expect(page.locator("#book-title")).toHaveText("Livro revisado");
  });
});

test("cancelar navegação mantém ajustes e descartar não grava", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Ajustes pendentes");
    await page.locator(".chapter-row .tree-button").first().click();
    await expect(page.locator("#changes-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Continuar editando", exact: true }).click();
    await expect(page.locator("#markdown")).toHaveValue("# Ajustes pendentes");
    await page.locator(".chapter-row .tree-button").first().click();
    await page.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(page.locator("#chapter-view")).toBeVisible();
    assert.equal(await diskText(page, "index.md"), fixture["index.md"]);
  });
});

test("salvar e continuar persiste antes de navegar", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Ajustes salvos");
    await page.locator(".chapter-row .tree-button").first().click();
    await page.getByRole("button", { name: "Salvar e continuar", exact: true }).click();
    await expect(page.locator("#chapter-view")).toBeVisible();
    assert.equal(await diskText(page, "index.md"), "# Ajustes salvos");
  });
});

test("trocar de ebook exige confirmação e cancelar conserva o livro atual", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      window.nextRoot = await storage.getDirectoryHandle("Segundo livro", { create: true });
      const handle = await window.nextRoot.getFileHandle("index.md", { create: true });
      const stream = await handle.createWritable();
      await stream.write("# Outro livro");
      await stream.close();
      window.showDirectoryPicker = async () => window.nextRoot;
    });
    await page.locator("#markdown").fill("# Não perder");
    await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
    await page.getByRole("button", { name: "Continuar editando", exact: true }).click();
    await expect(page.locator("#book-title")).toHaveText("Livro de teste");
    await expect(page.locator("#markdown")).toHaveValue("# Não perder");
    await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
    await page.getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(page.locator("#book-title")).toHaveText("Outro livro");
    assert.equal(await diskText(page, "index.md"), fixture["index.md"]);
  });
});

test("preserva UTF-8 BOM e CRLF sem marcar um arquivo recém-aberto como alterado", async () => {
  await withEditor({ ...fixture, "index.md": "\uFEFF# Livro Windows\r\n\r\nOlá.\r\n" }, async (page) => {
    await open(page);
    await expect(page.locator("#save")).toBeDisabled();
    await page.locator("#markdown").fill("# Livro Windows\n\nOlá, revisão.\n");
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    const bytes = await page.evaluate(async () => {
      const handle = await window.testRoot.getFileHandle("index.md");
      return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    });
    assert.deepEqual(bytes.slice(0, 3), [239, 187, 191]);
    assert.equal(new TextDecoder().decode(Uint8Array.from(bytes)), "# Livro Windows\r\n\r\nOlá, revisão.\r\n");
  });
});

test("usa o título do frontmatter na lateral e o preserva ao salvar", async () => {
  const frontmatter = "---\r\ntitle: \"Título oficial do livro\"\r\nprivate: segredo\r\n---\r\n";
  await withEditor({
    ...fixture,
    "index.md": `\uFEFF${frontmatter}# Livro visível\r\n\r\nTexto original.\r\n`,
  }, async (page) => {
    await open(page);
    await expect(page.locator("#markdown")).toHaveValue("# Livro visível\n\nTexto original.\n");
    await expect(page.locator("#preview")).not.toContainText("segredo");
    await expect(page.locator("#preview")).not.toContainText("title:");
    await expect(page.locator("#preview h1")).toHaveText("Livro visível");
    await expect(page.locator("#book-title")).toHaveText("Título oficial do livro");

    await page.locator("#markdown").fill("# Título atualizado\n\nTexto alterado.");
    await page.locator("#save").click();
    await expect(page.locator("#save-status")).toHaveText("Salvo");
    await expect(page.locator("#book-title")).toHaveText("Título oficial do livro");
    const bytes = await page.evaluate(async () => {
      const handle = await window.testRoot.getFileHandle("index.md");
      return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    });
    assert.deepEqual(bytes.slice(0, 3), [239, 187, 191]);
    assert.equal(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes)),
      `\uFEFF${frontmatter}# Título atualizado\r\n\r\nTexto alterado.`,
    );
  });
});

test("bloqueia sobrescrita de arquivo modificado fora do editor", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Minha revisão");
    await page.evaluate(async () => {
      const handle = await window.testRoot.getFileHandle("index.md");
      const writable = await handle.createWritable();
      await writable.write("# Alteração externa");
      await writable.close();
    });
    await page.locator("#save").click();
    await expect(page.locator("#notice")).toContainText("alterado fora do editor");
    await expect(page.locator("#save-status")).toHaveText("Não salvo");
    assert.equal(await diskText(page, "index.md"), "# Alteração externa");
    await expect(page.locator("#markdown")).toHaveValue("# Minha revisão");
    await page.locator(".chapter-row .tree-button").first().click();
    await page.getByRole("button", { name: "Salvar e continuar", exact: true }).click();
    await expect(page.locator("#editor-view")).toBeVisible();
    await expect(page.locator("#markdown")).toHaveValue("# Minha revisão");
  });
});

test("erros de pasta inválida e cancelamento do seletor conservam o editor", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Ajuste pendente");
    await page.evaluate(() => {
      window.showDirectoryPicker = async () => { throw new DOMException("Cancelado", "AbortError"); };
    });
    await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
    await expect(page.locator("#markdown")).toBeEnabled();
    await expect(page.locator("#markdown")).toHaveValue("# Ajuste pendente");
    await page.evaluate(async () => {
      const storage = await navigator.storage.getDirectory();
      const empty = await storage.getDirectoryHandle("vazio", { create: true });
      window.showDirectoryPicker = async () => empty;
    });
    await page.getByRole("button", { name: "ABRIR EBOOK", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("não contém index.md");
    await expect(page.locator("#markdown")).toHaveValue("# Ajuste pendente");
    await expect(page.locator("#changes-dialog")).not.toBeVisible();
  });
});

test("busca sessões por título e links internos abrem o index.md correto", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#preview").getByRole("link", { name: "Ir para sessão" }).click();
    await expect(page.locator("#document-path")).toHaveText("01/02/index.md");
    await expect(page.locator("#preview h2")).toHaveAttribute("id", "detalhes");
    await page.locator("#search").fill("avançado");
    await expect(page.locator(".chapter-row .tree-label")).toHaveCount(1);
    await expect(page.locator(".chapter-row .tree-label")).toHaveText("Capítulo 10: Avançado");
    await page.locator("#search").fill("nenhuma correspondência");
    await expect(page.locator("#book-tree")).toHaveText("Nenhum capítulo ou sessão encontrado.");
  });
});

test("renderiza GFM, remove HTML ativo e resolve imagens absolutas localmente", async () => {
  await withEditor({
    ...fixture,
    "_images/test.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>',
  }, async (page) => {
    await open(page);
    const requests = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(baseURL) && !request.url().startsWith("blob:")) requests.push(request.url());
    });
    await page.locator("#markdown").fill([
      "# Prévia segura",
      "",
      "| A | B |", "| - | - |", "| 1 | 2 |",
      "",
      "- [x] Feito",
      "",
      "```js", "const x = 1;", "```",
      "",
      '<script>window.injected = true</script>',
      '<img src="https://explanna.blob.core.windows.net/public/schools/balta/contents/ibooks/test/images/test.svg" onerror="window.injected = true">',
      '<iframe src="https://example.com"></iframe>',
      '<a href="javascript:alert(1)">Link inseguro</a>',
    ].join("\n"));
    await expect(page.locator("#preview table")).toBeVisible();
    await expect(page.locator("#preview pre code")).toContainText("const x = 1");
    await expect(page.locator("#preview input")).toBeDisabled();
    assert.equal(await page.locator("#preview script, #preview iframe, #preview [onerror]").count(), 0);
    await expect(page.locator("#preview img")).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => page.locator("#preview img").evaluate((image) => image.naturalWidth)).toBe(10);
    const image = page.locator("#preview img");
    assert.equal(await image.evaluate((element) => getComputedStyle(element).filter), "none");
    await page.locator("#theme-toggle").click();
    assert.equal(await image.evaluate((element) => getComputedStyle(element).filter), "invert(1) hue-rotate(180deg)");
    await page.locator("#theme-toggle").click();
    assert.equal(await image.evaluate((element) => getComputedStyle(element).filter), "none");
    assert.match(await page.locator("#markdown").inputValue(), /https:\/\/explanna\.blob\.core\.windows\.net\/public\/schools\/balta\/contents\/ibooks\/test\/images\/test\.svg/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.deepEqual(requests, []);
  });
});

test("atualiza imagem absoluta para _images após editar Markdown sem alterar o original", async () => {
  const original = "![Mapa](https://explanna.blob.core.windows.net/public/schools/balta/contents/ibooks/linguagem-de-programacao-ii/images/01_01_mapa-do-curso.svg)";
  const updated = "![Mapa](https://explanna.blob.core.windows.net/public/schools/balta/contents/ibooks/linguagem-de-programacao-ii/images/02_01_mapa-do-curso.svg)";
  await withEditor({
    ...fixture,
    "01/02/index.md": original,
    "_images/01_01_mapa-do-curso.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    "_images/02_01_mapa-do-curso.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
  }, async (page) => {
    await open(page);
    await page.locator(".chapter-row .tree-button").first().click();
    await page.locator(".chapter-children .tree-button").nth(1).click();

    await expect(page.locator("#markdown")).toHaveValue(original);
    await expect.poll(() => page.locator("#preview img").evaluate((image) => image.naturalWidth)).toBe(10);
    await expect(page.locator("#markdown")).toHaveValue(original);

    await page.locator("#markdown").fill(updated);
    await expect(page.locator("#markdown")).toHaveValue(updated);
    await expect.poll(() => page.locator("#preview img").evaluate((image) => image.naturalWidth)).toBe(20);
    await expect(page.locator("#markdown")).toHaveValue(updated);
  });
});

test("carrega imagens locais e impede caminhos fora da pasta do ebook", async () => {
  await withEditor({ ...fixture, "assets/pixel.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>' }, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Imagem\n\n![Pixel](assets/pixel.svg)");
    await expect(page.locator("#preview img")).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => page.locator("#preview img").evaluate((image) => image.naturalWidth)).toBe(10);
    await page.locator("#markdown").fill("# Imagem\n\n![Fora](../fora.png)");
    await expect(page.locator("#notice")).toContainText("fora da pasta do ebook");
    await expect(page.locator("#preview img")).not.toHaveAttribute("src");
  });
});

test("abre a imagem em alta resolução na prévia e permite fechar com teclado e botão", async () => {
  await withEditor({
    ...fixture,
    "_images/high-resolution.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="green"/></svg>',
  }, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Imagem\n\n![Gráfico](_images/high-resolution.svg)");
    const previewImage = page.locator("#preview img");
    await expect(previewImage).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => previewImage.evaluate((image) => image.naturalWidth)).toBe(1200);
    await expect(previewImage).toHaveCSS("cursor", "pointer");

    await previewImage.click();
    const dialog = page.locator("#image-dialog");
    const dialogImage = page.locator("#image-dialog-image");
    await expect(dialog).toBeVisible();
    await expect(dialogImage).toHaveAttribute("src", await previewImage.getAttribute("src"));
    assert.equal(await dialogImage.evaluate((image) => image.naturalWidth), 1200);
    assert.ok((await dialogImage.boundingBox()).width > (await previewImage.boundingBox()).width);
    await expect(dialogImage).toHaveCSS("filter", "none");

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await page.locator("#theme-toggle").click();
    await previewImage.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialogImage).toHaveCSS("filter", "invert(1) hue-rotate(180deg)");
    await page.locator("#image-dialog-close").click();
    await expect(dialog).not.toBeVisible();
    await expect(dialogImage).not.toHaveAttribute("src");

    await page.locator("#theme-toggle").click();
    await previewImage.click();
    await expect(dialog).toBeVisible();
    await expect(dialogImage).toHaveCSS("filter", "none");
    await dialog.click({ position: { x: 2, y: 2 } });
    await expect(dialog).not.toBeVisible();
  });
});

test("formatação mantém seleção e pode ser desfeita", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").focus();
    await page.evaluate(() => {
      const editor = document.getElementById("markdown");
      const start = editor.value.indexOf("Sobre");
      editor.setSelectionRange(start, start + 5);
    });
    await page.getByRole("button", { name: "Inserir negrito", exact: true }).click();
    await expect(page.locator("#markdown")).toHaveValue(fixture["index.md"].replace("Sobre", "**Sobre**"));
    await page.keyboard.press("Control+z");
    await expect(page.locator("#markdown")).toHaveValue(fixture["index.md"]);
    await expect(page.locator("#save")).toBeDisabled();
  });
});

test("navegador incompatível recebe aviso e não pode abrir pastas", async () => {
  await withEditor(fixture, async (page) => {
    await expect(page.locator("#open-book")).toBeDisabled();
    await expect(page.locator("#compatibility")).toContainText("Chrome ou Edge");
    await expect(page.locator("#notice")).toContainText("API indisponível");
  }, (page) => page.addInitScript(() => {
    window.showDirectoryPicker = undefined;
  }));
});

test("layouts desktop e móvel mantêm o botão de abertura e os dois painéis", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    const editor = await page.locator(".markdown-pane").boundingBox();
    const preview = await page.locator(".preview-pane").boundingBox();
    assert.ok(preview.x >= editor.x + editor.width - 1, "Painéis lado a lado no desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#open-book")).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Sem overflow horizontal");
    const mobileEditor = await page.locator(".markdown-pane").boundingBox();
    const mobilePreview = await page.locator(".preview-pane").boundingBox();
    assert.ok(mobilePreview.y >= mobileEditor.y + mobileEditor.height - 1, "Painéis empilhados no celular");
  });
});

test("negação de permissão conserva o rascunho e não grava", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Rascunho protegido");
    await page.evaluate(() => {
      FileSystemFileHandle.prototype.queryPermission = async () => "denied";
      FileSystemFileHandle.prototype.requestPermission = async () => "denied";
    });
    await page.locator("#save").click();
    await expect(page.locator("#notice")).toContainText("Permissão de escrita não concedida");
    await expect(page.locator("#save-status")).toHaveText("Não salvo");
    await expect(page.locator("#markdown")).toHaveValue("# Rascunho protegido");
    assert.equal(await diskText(page, "index.md"), fixture["index.md"]);
  });
});

test("erro de escrita aborta a transação e não sinaliza sucesso", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Rascunho protegido");
    await page.evaluate(() => {
      const native = FileSystemFileHandle.prototype.createWritable;
      window.aborts = 0;
      FileSystemFileHandle.prototype.createWritable = async function (options) {
        const stream = await native.call(this, options);
        return {
          async write() { throw new Error("Falha de escrita simulada"); },
          close: () => stream.close(),
          async abort() { window.aborts++; await stream.abort(); },
        };
      };
    });
    await page.locator("#save").click();
    await expect(page.locator("#notice")).toContainText("Falha de escrita simulada");
    await expect(page.locator("#save-status")).toHaveText("Não salvo");
    assert.equal(await page.evaluate(() => window.aborts), 1);
    assert.equal(await diskText(page, "index.md"), fixture["index.md"]);
  });
});

test("erro ao ler destino não descarta as alterações atuais", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Rascunho protegido");
    await page.evaluate(() => {
      FileSystemFileHandle.prototype.getFile = async () => { throw new Error("Arquivo removido"); };
    });
    await page.locator(".chapter-row .tree-button").nth(1).click();
    await expect(page.locator("#notice")).toContainText("Arquivo removido");
    await expect(page.locator("#changes-dialog")).not.toBeVisible();
    await expect(page.locator("#markdown")).toHaveValue("# Rascunho protegido");
    await expect(page.locator("#markdown")).toBeEnabled();
  });
});

test("rolagem sincronizada é proporcional e pode ser desativada", async () => {
  const text = "# Texto longo\n\n" + Array.from({ length: 180 }, (_, i) => `Parágrafo ${i}: ${"conteúdo ".repeat(15)}\n\n`).join("");
  await withEditor({ ...fixture, "index.md": text }, async (page) => {
    await open(page);
    await page.evaluate(() => {
      const editor = document.getElementById("markdown");
      editor.scrollTop = (editor.scrollHeight - editor.clientHeight) * 0.6;
    });
    await expect.poll(() => page.locator("#preview-scroll").evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight))).toBeGreaterThan(0.58);
    const ratio = await page.locator("#preview-scroll").evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight));
    assert.ok(Math.abs(ratio - 0.6) < 0.02);
    await page.locator("#sync-scroll").uncheck();
    const previous = await page.locator("#preview-scroll").evaluate((el) => el.scrollTop);
    await page.evaluate(() => { document.getElementById("markdown").scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#preview-scroll").evaluate((el) => el.scrollTop), previous);
  });
});

test("fechar ou recarregar pede confirmação se há alterações pendentes", async () => {
  await withEditor(fixture, async (page) => {
    await open(page);
    await page.locator("#markdown").fill("# Alterações pendentes");
    let prompted = false;
    page.once("dialog", async (dialog) => {
      prompted = true;
      assert.equal(dialog.type(), "beforeunload");
      await dialog.dismiss();
    });
    await assert.rejects(page.reload({ timeout: 1000 }), /ERR_ABORTED|Timeout/);
    assert.equal(prompted, true);
    await expect(page.locator("#markdown")).toHaveValue("# Alterações pendentes");
  });
});

test("abre todos os index.md do ebook de exemplo sem modificar os arquivos de origem", {
  skip: !process.env.EBOOK_SAMPLE_PATH,
  timeout: 120000,
}, async () => {
  const root = process.env.EBOOK_SAMPLE_PATH;
  const entries = {};
  function collect(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const location = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(absolute, location);
      else if (entry.name === "index.md") entries[location] = fs.readFileSync(absolute, "utf8");
    }
  }
  collect(root);
  const chapters = [...new Set(Object.keys(entries).filter((key) => key.includes("/")).map((key) => key.split("/")[0]))]
    .sort(new Intl.Collator("pt-BR", { numeric: true }).compare);
  let visited = 1;
  await withEditor(entries, async (page) => {
    await open(page);
    for (let index = 0; index < chapters.length; index++) {
      const chapter = chapters[index];
      await page.locator(".chapter-row .tree-button").nth(index).click();
      if (entries[`${chapter}/index.md`]) {
        await expect(page.locator("#document-path")).toHaveText(`${chapter}/index.md`);
        visited++;
      }
      const sessions = Object.keys(entries)
        .filter((key) => key.startsWith(chapter + "/") && key.split("/").length === 3)
        .sort(new Intl.Collator("pt-BR", { numeric: true }).compare);
      for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
        await page.locator(".tree-chapter").nth(index).locator(".chapter-children .tree-button").nth(sessionIndex).click();
        const location = sessions[sessionIndex];
        await expect(page.locator("#document-path")).toHaveText(location);
        await expect(page.locator("#markdown")).toHaveValue(entries[location].replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
        await expect(page.locator("#preview h1")).not.toHaveCount(0);
        await expect(page.locator("#save")).toBeDisabled();
        visited++;
      }
    }
    assert.equal(visited, Object.keys(entries).length);
    for (const [location, content] of Object.entries(entries)) {
      assert.equal(fs.readFileSync(path.join(root, ...location.split("/")), "utf8"), content);
    }
    console.log(`Ebook de exemplo validado: ${chapters.length} capítulos, ${visited} arquivos Markdown.`);
  });
});
