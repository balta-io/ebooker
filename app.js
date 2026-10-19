(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "open-book", "welcome-open", "theme-toggle", "notice", "book-title", "book-meta", "search",
    "book-tree", "welcome", "compatibility", "editor-view", "chapter-view",
    "breadcrumbs", "document-title", "document-path", "document-reading-time", "save", "save-status",
    "markdown", "preview", "preview-scroll", "word-count", "sync-scroll",
    "chapter-breadcrumbs", "chapter-title", "chapter-reading-time", "chapter-sessions", "changes-dialog",
    "image-dialog", "image-dialog-close", "image-dialog-image",
  ].map((id) => [id, $(id)]));
  const state = {
    book: null,
    current: null,
    selected: null,
    original: "",
    frontmatter: "",
    diskText: "",
    bom: false,
    busy: false,
    renderVersion: 0,
    imageURLs: [],
    noticeTimer: null,
    renderTimer: null,
  };
  let sessionDatabase;
  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  const supported = window.isSecureContext && typeof window.showDirectoryPicker === "function";
  const librariesReady = typeof window.marked?.parse === "function" && Boolean(window.DOMPurify?.isSupported);

  function applyTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    const action = theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro";
    ui["theme-toggle"].setAttribute("aria-label", action);
    ui["theme-toggle"].title = action;
    if (persist) {
      try {
        localStorage.setItem("ebooker-theme", theme);
      } catch (error) {
        report(error, "Não foi possível salvar sua preferência de tema.");
      }
    }
  }

  function notify(message, error = false) {
    clearTimeout(state.noticeTimer);
    ui.notice.textContent = message;
    ui.notice.classList.toggle("error", error);
    ui.notice.setAttribute("role", error ? "alert" : "status");
    ui.notice.hidden = false;
    if (!error) state.noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 6000);
  }

  function report(error, context) {
    console.error(context, error);
    const detail = error.name === "NotAllowedError"
      ? "Permissão negada. Autorize o acesso à pasta e tente novamente."
      : error.message || String(error);
    notify(`${context} ${detail}`, true);
  }

  function openSessionDatabase() {
    if (sessionDatabase) return sessionDatabase;
    sessionDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open("ebooker-session", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("last-selection");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento da sessão."));
      request.onblocked = () => reject(new Error("O armazenamento da sessão está bloqueado por outra aba."));
    });
    return sessionDatabase;
  }

  async function readLastSelection() {
    const database = await openSessionDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("last-selection", "readonly");
      const request = transaction.objectStore("last-selection").get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Não foi possível ler a última seleção."));
      transaction.onabort = () => reject(transaction.error || new Error("A leitura da última seleção foi cancelada."));
    });
  }

  async function persistLastSelection() {
    if (!state.book || !state.selected) return;
    try {
      const database = await openSessionDatabase();
      const selected = state.selected;
      const record = {
        root: state.book.root,
        kind: selected.handle ? "document" : "chapter",
        path: selected.path || selected.name,
      };
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("last-selection", "readwrite");
        transaction.objectStore("last-selection").put(record, "current");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Não foi possível salvar a última seleção."));
        transaction.onabort = () => reject(transaction.error || new Error("O salvamento da última seleção foi cancelado."));
      });
    } catch (error) {
      report(error, "Não foi possível lembrar o último conteúdo.");
    }
  }

  async function restoreLastSelection() {
    if (!supported || !librariesReady || state.busy) return;
    state.busy = true;
    updateControls();
    try {
      const saved = await readLastSelection();
      if (!saved) return;
      if (!saved.root || saved.root.kind !== "directory" || typeof saved.root.queryPermission !== "function") {
        throw new Error("A pasta salva para a última seleção não está disponível.");
      }
      if (await saved.root.queryPermission({ mode: "read" }) !== "granted") {
        notify("O último ebook foi encontrado. Clique em ABRIR EBOOK e autorize o acesso para retomá-lo.");
        return;
      }
      const book = await scanBook(saved.root);
      let selected;
      if (saved.kind === "document") selected = book.documents.get(saved.path);
      if (saved.kind === "chapter") {
        selected = book.chapters.find((chapter) => chapter.name === saved.path && !chapter.document);
      }
      state.book = book;
      updateBookInfo();
      if (selected?.handle) {
        const loaded = await readDocument(selected);
        displayDocument(selected, loaded);
      } else if (selected) {
        displayChapter(selected);
      } else {
        displayDocument(book.about, await readDocument(book.about));
        notify("O último conteúdo não existe mais. A apresentação do ebook foi aberta.");
        return;
      }
      notify(`Último conteúdo restaurado: ${book.title}.`);
    } catch (error) {
      report(error, "Não foi possível restaurar o último ebook.");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function isDirty() {
    return Boolean(state.current) && ui.markdown.value !== state.original;
  }

  function updateControls() {
    const dirty = isDirty();
    ui["open-book"].disabled = state.busy || !supported || !librariesReady;
    ui["welcome-open"].disabled = ui["open-book"].disabled;
    ui.search.disabled = state.busy || !state.book;
    ui.markdown.disabled = state.busy || !state.current;
    ui.save.disabled = state.busy || !dirty;
    document.querySelectorAll("[data-format]").forEach((button) => {
      button.disabled = state.busy || !state.current;
    });
    ui["save-status"].textContent = state.busy ? "Aguarde…" : dirty ? "Não salvo" : "Salvo";
    ui["save-status"].classList.toggle("dirty", dirty);
    document.title = `${dirty ? "• " : ""}${state.current?.title || state.book?.title || "Editor de ebooks"} — Ebooker`;
  }

  function heading(text, fallback) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const marker = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1][0];
        else if (marker[1][0] === fence) fence = null;
        continue;
      }
      if (fence) continue;
      const atx = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
      const setext = lines[i].trim() && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1] || "");
      if (atx || setext) {
        const fragment = DOMPurify.sanitize(marked.parseInline(atx ? atx[1] : lines[i].trim()), { RETURN_DOM_FRAGMENT: true });
        return fragment.textContent.trim() || fallback;
      }
    }
    return fallback;
  }

  function splitFrontmatter(text) {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const match = normalized.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
    return {
      frontmatter: match?.[0] || "",
      content: match ? normalized.slice(match[0].length) : normalized,
    };
  }

  function frontmatterTitle(frontmatter) {
    const normalized = frontmatter.replace(/\r\n?/g, "\n");
    const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    const titleLine = match?.[1].split("\n").find((line) => /^title\s*:/i.test(line));
    if (!titleLine) return null;
    let title = titleLine.replace(/^title\s*:\s*/i, "").trim();
    if (!title || /^(?:null|~)$/i.test(title)) return null;
    if (title.startsWith('"') && title.endsWith('"')) {
      try {
        title = JSON.parse(title);
      } catch {
        title = title.slice(1, -1);
      }
    } else if (title.startsWith("'") && title.endsWith("'")) {
      title = title.slice(1, -1).replace(/''/g, "'");
    } else {
      title = title.replace(/\s+#.*$/, "").trim();
    }
    return title || null;
  }

  function frontmatterMenuLabel(frontmatter) {
    const match = frontmatter.match(/^\s*lecture_type\s*:\s*["']?(hands_on|quiz)["']?\s*(?:#.*)?$/im);
    if (match?.[1].toLowerCase() === "hands_on") return "Laboratório";
    if (match?.[1].toLowerCase() === "quiz") return "Quiz";
    return null;
  }

  async function indexFile(directory) {
    try {
      return await directory.getFileHandle("index.md");
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async function directories(directory) {
    const result = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "directory" && !name.startsWith(".")) result.push(handle);
    }
    return result.sort((a, b) => collator.compare(a.name, b.name));
  }

  async function describeFile(handle, parts, fallback, kind, chapter = null) {
    const file = await handle.getFile();
    const text = await file.text();
    const { frontmatter, content } = splitFrontmatter(text);
    const title = kind === "about" || kind === "chapter"
      ? frontmatterTitle(frontmatter) || heading(content, fallback)
      : heading(content, fallback);
    const menuTitle = kind === "session" ? frontmatterMenuLabel(frontmatter) || title : title;
    return { handle, parts, path: parts.join("/"), title, menuTitle, wordCount: countWords(content), kind, chapter };
  }

  async function scanBook(root) {
    const handle = await indexFile(root);
    if (!handle) {
      throw new Error("A pasta selecionada não contém index.md na raiz. Extraia o ZIP e selecione a pasta do livro, não a pasta que a contém.");
    }
    const about = await describeFile(handle, ["index.md"], root.name, "about");
    const book = { root, title: about.title, about, chapters: [], documents: new Map([[about.path, about]]) };
    for (const directory of await directories(root)) {
      const chapter = { name: directory.name, title: directory.name, document: null, sessions: [], expanded: false };
      const chapterHandle = await indexFile(directory);
      if (chapterHandle) {
        chapter.document = await describeFile(chapterHandle, [directory.name, "index.md"], directory.name, "chapter", chapter);
        chapter.title = chapter.document.title;
      }
      for (const sessionDirectory of await directories(directory)) {
        const sessionHandle = await indexFile(sessionDirectory);
        if (!sessionHandle) continue;
        const session = await describeFile(sessionHandle, [directory.name, sessionDirectory.name, "index.md"], sessionDirectory.name, "session", chapter);
        session.name = sessionDirectory.name;
        chapter.sessions.push(session);
      }
      if (!chapter.document && !chapter.sessions.length) continue;
      if (!chapter.document && /^cap[ií]tulo\b/i.test(chapter.sessions[0].title)) {
        chapter.title = chapter.sessions[0].title;
      }
      book.chapters.push(chapter);
      if (chapter.document) book.documents.set(chapter.document.path, chapter.document);
      chapter.sessions.forEach((session) => book.documents.set(session.path, session));
    }
    return book;
  }

  function treeButton(label, symbol, selected, action, words) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-button${selected ? " active" : ""}`;
    if (selected) button.setAttribute("aria-current", "page");
    const icon = document.createElement("span");
    icon.className = "tree-symbol";
    icon.textContent = symbol;
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "tree-label";
    text.textContent = label;
    const details = document.createElement("span");
    details.className = "tree-details";
    const duration = document.createElement("small");
    duration.className = "tree-reading-time";
    duration.textContent = formatReadingTime(words);
    details.append(text, duration);
    button.append(icon, details);
    button.addEventListener("click", action);
    return button;
  }

  function renderTree() {
    if (!state.book) return;
    const query = ui.search.value.trim().toLocaleLowerCase("pt-BR");
    const matches = (text) => text.toLocaleLowerCase("pt-BR").includes(query);
    const tree = document.createDocumentFragment();
    if (!query || matches(`Sobre o livro ${state.book.title}`)) {
      tree.append(treeButton("Sobre o livro", "▤", state.selected === state.book.about, () => navigate(state.book.about), documentWords(state.book.about)));
    }
    for (const chapter of state.book.chapters) {
      const chapterMatch = matches(`${chapter.name} ${chapter.title}`);
      const sessions = chapter.sessions.filter((session) => chapterMatch || matches(`${session.name} ${session.title} ${session.menuTitle}`));
      if (!chapterMatch && !sessions.length) continue;
      const group = document.createElement("div");
      group.className = "tree-chapter";
      const row = document.createElement("div");
      row.className = "chapter-row";
      row.append(treeButton(chapter.title, chapter.name, state.selected === chapter || state.selected === chapter.document, () => navigate(chapter.document || chapter), chapterWords(chapter)));
      if (chapter.sessions.length) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "chapter-toggle";
        toggle.textContent = chapter.expanded || query ? "⌄" : "›";
        toggle.setAttribute("aria-label", `Expandir ou recolher ${chapter.title}`);
        toggle.setAttribute("aria-expanded", String(Boolean(chapter.expanded || query)));
        toggle.addEventListener("click", () => {
          chapter.expanded = !chapter.expanded;
          renderTree();
        });
        row.append(toggle);
      }
      group.append(row);
      if (chapter.expanded || query) {
        const children = document.createElement("div");
        children.className = "chapter-children";
        sessions.forEach((session) => {
          children.append(treeButton(session.menuTitle, session.name, state.selected === session, () => navigate(session), documentWords(session)));
        });
        group.append(children);
      }
      tree.append(group);
    }
    if (!tree.childNodes.length) {
      const empty = document.createElement("p");
      empty.className = "tree-placeholder";
      empty.textContent = "Nenhum capítulo ou sessão encontrado.";
      tree.append(empty);
    }
    ui["book-tree"].replaceChildren(tree);
  }

  function confirmChanges() {
    return new Promise((resolve) => {
      ui["changes-dialog"].returnValue = "cancel";
      ui["changes-dialog"].addEventListener("close", () => {
        resolve(ui["changes-dialog"].returnValue || "cancel");
      }, { once: true });
      ui["changes-dialog"].showModal();
    });
  }

  async function allowLeave() {
    if (!isDirty()) return true;
    const choice = await confirmChanges();
    if (choice === "save") return saveCurrent();
    return choice === "discard";
  }

  async function readDocument(doc) {
    const file = await doc.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    };
  }

  function releaseImages() {
    closeImageDialog();
    state.imageURLs.forEach((url) => URL.revokeObjectURL(url));
    state.imageURLs = [];
  }

  function closeImageDialog() {
    if (ui["image-dialog"].open) ui["image-dialog"].close();
    ui["image-dialog-image"].removeAttribute("src");
    ui["image-dialog-image"].alt = "";
  }

  function openImageDialog(image) {
    if (!image.src || !image.naturalWidth) return;
    ui["image-dialog-image"].src = image.currentSrc || image.src;
    ui["image-dialog-image"].alt = image.alt;
    ui["image-dialog"].showModal();
  }

  function displayDocument(doc, loaded) {
    clearTimeout(state.renderTimer);
    state.current = doc;
    state.selected = doc;
    state.diskText = loaded.text;
    const parts = splitFrontmatter(loaded.text);
    state.frontmatter = parts.frontmatter;
    state.original = parts.content;
    state.bom = loaded.bom;
    ui.markdown.value = parts.content;
    doc.title = heading(parts.content, doc.title);
    doc.wordCount = countWords(parts.content);
    if (doc.chapter) doc.chapter.expanded = true;
    ui.welcome.hidden = true;
    ui["chapter-view"].hidden = true;
    ui["editor-view"].hidden = false;
    updateDocumentHeading();
    ui.markdown.scrollTop = 0;
    ui["preview-scroll"].scrollTop = 0;
    renderTree();
    renderPreview();
    updateControls();
  }

  function updateDocumentHeading() {
    const doc = state.current;
    if (!doc) return;
    ui["document-title"].textContent = doc.kind === "about" ? "Sobre o livro" : doc.title;
    ui["document-path"].textContent = doc.path;
    const trail = [state.book.title];
    if (doc.chapter) trail.push(doc.chapter.title);
    trail.push(doc.kind === "about" ? "Sobre o livro" : doc.kind === "chapter" ? "Apresentação do capítulo" : `Sessão ${doc.name}`);
    ui.breadcrumbs.textContent = trail.join("  /  ");
  }

  function displayChapter(chapter) {
    clearTimeout(state.renderTimer);
    state.renderVersion++;
    releaseImages();
    state.current = null;
    state.selected = chapter;
    chapter.expanded = true;
    ui.welcome.hidden = true;
    ui["editor-view"].hidden = true;
    ui["chapter-view"].hidden = false;
    ui["chapter-breadcrumbs"].textContent = `${state.book.title}  /  Capítulo ${chapter.name}`;
    ui["chapter-title"].textContent = chapter.title;
    ui["chapter-reading-time"].textContent = formatReadingTime(chapterWords(chapter));
    const cards = chapter.sessions.map((session) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-card";
      const number = document.createElement("span");
      number.textContent = session.name;
      const text = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = session.title;
      const location = document.createElement("small");
      location.textContent = session.path;
      const duration = document.createElement("small");
      duration.className = "session-reading-time";
      duration.textContent = formatReadingTime(documentWords(session));
      const arrow = document.createElement("span");
      arrow.textContent = "↗";
      arrow.setAttribute("aria-hidden", "true");
      text.append(title, duration, location);
      button.append(number, text, arrow);
      button.addEventListener("click", () => navigate(session));
      return button;
    });
    ui["chapter-sessions"].replaceChildren(...cards);
    updateBookInfo();
    renderTree();
    updateControls();
  }

  async function navigate(target) {
    if (state.busy || target === state.selected) return;
    state.busy = true;
    updateControls();
    try {
      // Read the destination before discarding anything in the current editor.
      const loaded = target.handle ? await readDocument(target) : null;
      if (!await allowLeave()) return;
      if (loaded) displayDocument(target, loaded);
      else displayChapter(target);
      await persistLastSelection();
    } catch (error) {
      report(error, "Não foi possível abrir o conteúdo.");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  async function openBook() {
    if (state.busy || !supported || !librariesReady) return;
    state.busy = true;
    updateControls();
    try {
      // Invoke the picker directly from the click, preserving browser user activation.
      const root = await window.showDirectoryPicker({ mode: "readwrite", id: "ebooker" });
      const book = await scanBook(root);
      const loaded = await readDocument(book.about);
      if (!await allowLeave()) return;
      state.book = book;
      ui.search.value = "";
      updateBookInfo();
      displayDocument(book.about, loaded);
      await persistLastSelection();
      notify(`Ebook aberto: ${book.title}.`);
    } catch (error) {
      if (error.name !== "AbortError") report(error, "Não foi possível abrir o ebook.");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function updateBookInfo() {
    ui["book-title"].textContent = state.book.title;
    const chapters = state.book.chapters.length;
    const sessions = state.book.chapters.reduce((sum, chapter) => sum + chapter.sessions.length, 0);
    const words = documentWords(state.book.about) + state.book.chapters.reduce((sum, chapter) => sum + chapterWords(chapter), 0);
    ui["book-meta"].textContent = `${chapters} ${chapters === 1 ? "capítulo" : "capítulos"} · ${sessions} ${sessions === 1 ? "sessão" : "sessões"} · ${formatReadingTime(words)}`;
  }

  async function saveCurrent() {
    if (!state.current || !isDirty()) return true;
    const doc = state.current;
    let writable = null;
    let closed = false;
    try {
      const permission = { mode: "readwrite" };
      if (await doc.handle.queryPermission(permission) !== "granted"
          && await doc.handle.requestPermission(permission) !== "granted") {
        throw new Error("Permissão de escrita não concedida. Suas alterações continuam no editor.");
      }
      const disk = await readDocument(doc);
      if (disk.text !== state.diskText || disk.bom !== state.bom) {
        throw new Error("O arquivo foi alterado fora do editor. Nada foi sobrescrito. Copie seus ajustes antes de reabrir o ebook para carregar a versão atual.");
      }
      const content = state.frontmatter + ui.markdown.value;
      const diskContent = state.diskText.includes("\r\n") ? content.replace(/\n/g, "\r\n") : content;
      const diskText = (state.bom ? "\uFEFF" : "") + diskContent;
      writable = await doc.handle.createWritable({ keepExistingData: false });
      await writable.write(diskText);
      await writable.close();
      closed = true;
      state.original = ui.markdown.value;
      state.diskText = diskText;
      doc.title = heading(ui.markdown.value, doc.title);
      doc.wordCount = countWords(ui.markdown.value);
      if (doc.kind === "about") {
        state.book.title = frontmatterTitle(state.frontmatter) || doc.title;
        updateBookInfo();
      } else if (doc.kind === "chapter") {
        doc.chapter.title = doc.title;
      } else if (!doc.chapter.document && doc === doc.chapter.sessions[0]) {
        doc.chapter.title = /^cap[ií]tulo\b/i.test(doc.title) ? doc.title : doc.chapter.name;
      }
      updateDocumentHeading();
      updateBookInfo();
      renderTree();
      notify("Alterações salvas no arquivo original.");
      return true;
    } catch (error) {
      report(error, "Não foi possível salvar.");
      return false;
    } finally {
      if (writable && !closed) {
        try {
          await writable.abort();
        } catch (error) {
          report(error, "Não foi possível cancelar a escrita incompleta.");
        }
      }
    }
  }

  async function save() {
    if (state.busy || !isDirty()) return;
    state.busy = true;
    updateControls();
    try {
      await saveCurrent();
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function relativePath(value, sourceParts) {
    const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
    if (decoded.includes("\\") || decoded.includes("\0")) throw new Error("Caminho de arquivo inválido.");
    const parts = decoded.startsWith("/") ? [] : sourceParts.slice(0, -1);
    for (const part of decoded.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw new Error("O caminho aponta para fora da pasta do ebook.");
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return parts;
  }

  async function resourceFile(parts, book) {
    if (!parts.length) throw new Error("Caminho de imagem vazio.");
    let directory = book.root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    const handle = await directory.getFileHandle(parts.at(-1));
    return handle.getFile();
  }

  function imagePath(src, sourceParts) {
    if (/^(?:https?:)?\/\//i.test(src)) {
      const url = new URL(src, window.location.href);
      const filename = decodeURIComponent(url.pathname.split("/").at(-1) || "");
      if (!filename || filename === "." || filename === ".." || /[\/\\\0]/.test(filename)) {
        throw new Error("A URL da imagem não contém um nome de arquivo válido.");
      }
      return ["_images", filename];
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) {
      throw new Error("Imagens externas não são carregadas automaticamente. Use uma imagem dentro da pasta do ebook.");
    }
    return relativePath(src, sourceParts);
  }

  function addHeadingIDs() {
    const used = new Set();
    ui.preview.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((element) => {
      const base = element.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s+/g, "-") || "titulo";
      let id = base;
      let suffix = 0;
      while (used.has(id)) id = `${base}-${++suffix}`;
      used.add(id);
      element.id = id;
    });
  }

  function calculateReadingTimeSeconds(words) {
    return Math.ceil((words / 150) * 60);
  }

  function countWords(text) {
    return text.trim().match(/\S+/gu)?.length || 0;
  }

  function documentWords(doc) {
    return doc === state.current ? countWords(ui.markdown.value) : doc.wordCount;
  }

  function chapterWords(chapter) {
    return (chapter.document ? documentWords(chapter.document) : 0)
      + chapter.sessions.reduce((sum, session) => sum + documentWords(session), 0);
  }

  function formatReadingTime(words) {
    const seconds = calculateReadingTimeSeconds(words);
    if (seconds === 0) return "0 minutos de leitura";
    if (seconds < 60) return "menos de 1 minuto de leitura";
    if (seconds < 3600) {
      const minutes = Math.ceil(seconds / 60);
      return `${minutes.toLocaleString("pt-BR")} ${minutes === 1 ? "minuto" : "minutos"} de leitura`;
    }
    const hours = Number((seconds / 3600).toPrecision(3));
    return `${hours.toLocaleString("pt-BR", { maximumSignificantDigits: 3 })} ${hours === 1 ? "hora" : "horas"} de leitura`;
  }

  function renderPreview() {
    if (!state.current) return;
    const version = ++state.renderVersion;
    const source = state.current;
    const book = state.book;
    releaseImages();
    try {
      const html = marked.parse(ui.markdown.value, { gfm: true, breaks: false, async: false });
      const clean = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "video", "audio", "source"],
        FORBID_ATTR: ["style", "srcset", "autofocus"],
        RETURN_DOM_FRAGMENT: true,
      });
      // Remove image sources before insertion: even sanitized remote URLs can issue network requests.
      const images = [...clean.querySelectorAll("img")].map((image) => {
        const src = image.getAttribute("src") || "";
        image.removeAttribute("src");
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        return { image, src };
      });
      clean.querySelectorAll('input').forEach((input) => { input.disabled = true; });
      clean.querySelectorAll("a").forEach((link) => {
        link.rel = "noopener noreferrer";
        link.referrerPolicy = "no-referrer";
      });
      ui.preview.replaceChildren(clean);
      addHeadingIDs();
      for (const { image, src } of images) {
        loadImage(image, src, source, book, version);
      }
      const words = countWords(ui.markdown.value);
      const chars = ui.markdown.value.length;
      ui["word-count"].textContent = `${words.toLocaleString("pt-BR")} ${words === 1 ? "palavra" : "palavras"} · ${chars.toLocaleString("pt-BR")} caracteres · ${formatReadingTime(words)}`;
      ui["document-reading-time"].textContent = formatReadingTime(source.kind === "chapter" ? chapterWords(source.chapter) : words);
      updateBookInfo();
      renderTree();
    } catch (error) {
      ui.preview.textContent = "Não foi possível renderizar este Markdown.";
      report(error, "Erro na prévia.");
    }
  }

  async function loadImage(image, src, source, book, version) {
    try {
      if (!src) throw new Error("Caminho de imagem vazio.");
      const file = await resourceFile(imagePath(src, source.parts), book);
      if (version !== state.renderVersion) return;
      const url = URL.createObjectURL(file);
      state.imageURLs.push(url);
      image.src = url;
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", `Abrir imagem em alta resolução${image.alt ? `: ${image.alt}` : ""}`);
      image.addEventListener("error", () => {
        if (version === state.renderVersion) notify(`Não foi possível exibir a imagem: ${src}.`, true);
      }, { once: true });
    } catch (error) {
      if (version !== state.renderVersion) return;
      image.alt = `[Imagem indisponível: ${image.alt || src}]`;
      image.title = error.message;
      report(error, `Imagem indisponível (${src}).`);
    }
  }

  function scrollToAnchor(anchor) {
    if (!anchor) {
      ui["preview-scroll"].scrollTop = 0;
      return;
    }
    const id = decodeURIComponent(anchor);
    const target = [...ui.preview.querySelectorAll("[id]")].find((element) => element.id === id);
    if (!target) throw new Error(`Título não encontrado na prévia: ${id}.`);
    ui["preview-scroll"].scrollTop += target.getBoundingClientRect().top - ui["preview-scroll"].getBoundingClientRect().top - 15;
  }

  async function previewLink(event) {
    const link = event.target.closest("a");
    if (!link || !ui.preview.contains(link)) return;
    event.preventDefault();
    const href = link.getAttribute("href");
    if (!href || !state.current || state.busy) return;
    try {
      if (/^(https?:|mailto:)/i.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) throw new Error("Este tipo de link não é permitido.");
      const anchor = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      if (href.startsWith("#")) {
        scrollToAnchor(anchor);
        return;
      }
      const parts = relativePath(href, state.current.parts);
      if (!parts.at(-1)?.toLowerCase().endsWith(".md")) parts.push("index.md");
      const target = state.book.documents.get(parts.join("/"));
      if (!target) throw new Error("O link não aponta para um index.md disponível na estrutura do ebook.");
      await navigate(target);
      if (state.current === target) scrollToAnchor(anchor);
    } catch (error) {
      report(error, "Não foi possível abrir o link.");
    }
  }

  function edited() {
    updateControls();
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderPreview, 100);
  }

  function format(kind) {
    if (state.busy || !state.current) return;
    const editor = ui.markdown;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end);
    const eol = "\n";
    const formats = {
      bold: ["**", "**", "texto em negrito"],
      italic: ["*", "*", "texto em itálico"],
      link: ["[", "](https://exemplo.com)", "texto do link"],
      code: ["`", "`", "código"],
    };
    let replacement;
    let offset = 0;
    let length;
    if (formats[kind]) {
      const [before, after, placeholder] = formats[kind];
      const text = selected || placeholder;
      replacement = before + text + after;
      offset = before.length;
      length = text.length;
    } else {
      const prefix = { heading: "## ", list: "- ", quote: "> " }[kind];
      if (!prefix) return;
      const text = selected || "Texto";
      const needsBreak = start > 0 && editor.value[start - 1] !== "\n";
      replacement = (needsBreak ? eol : "") + text.split(/\r?\n/).map((line) => prefix + line).join(eol);
      offset = (needsBreak ? eol.length : 0) + prefix.length;
      length = text.length;
    }
    editor.focus();
    // Native insertion keeps formatting actions in the textarea's undo history.
    const inserted = document.execCommand("insertText", false, replacement);
    if (!inserted) editor.setRangeText(replacement, start, end, "end");
    editor.setSelectionRange(start + offset, start + offset + length);
    edited();
  }

  let scrolling = false;
  function syncScroll(source, destination) {
    if (scrolling || !ui["sync-scroll"].checked) return;
    const max = source.scrollHeight - source.clientHeight;
    const targetMax = destination.scrollHeight - destination.clientHeight;
    scrolling = true;
    destination.scrollTop = max > 0 ? source.scrollTop / max * targetMax : 0;
    requestAnimationFrame(() => { scrolling = false; });
  }

  ui["open-book"].addEventListener("click", openBook);
  ui["welcome-open"].addEventListener("click", openBook);
  ui["theme-toggle"].addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  ui.save.addEventListener("click", save);
  ui.search.addEventListener("input", renderTree);
  ui.markdown.addEventListener("input", edited);
  ui.preview.addEventListener("click", (event) => {
    const image = event.target.closest("img");
    if (image && ui.preview.contains(image)) {
      openImageDialog(image);
      return;
    }
    previewLink(event);
  });
  ui.preview.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const image = event.target.closest("img");
    if (!image || !ui.preview.contains(image)) return;
    event.preventDefault();
    openImageDialog(image);
  });
  ui["image-dialog-close"].addEventListener("click", () => ui["image-dialog"].close());
  ui["image-dialog"].addEventListener("click", (event) => {
    if (event.target === ui["image-dialog"]) ui["image-dialog"].close();
  });
  ui["image-dialog"].addEventListener("close", () => {
    ui["image-dialog-image"].removeAttribute("src");
    ui["image-dialog-image"].alt = "";
  });
  ui.markdown.addEventListener("scroll", () => syncScroll(ui.markdown, ui["preview-scroll"]));
  ui["preview-scroll"].addEventListener("scroll", () => syncScroll(ui["preview-scroll"], ui.markdown));
  ui.notice.addEventListener("click", () => { ui.notice.hidden = true; });
  document.querySelectorAll("[data-format]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => format(button.dataset.format));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
    if (event.key === "Tab" && event.target === ui.markdown && !state.busy) {
      event.preventDefault();
      const start = ui.markdown.selectionStart;
      const end = ui.markdown.selectionEnd;
      if (!document.execCommand("insertText", false, "  ")) {
        ui.markdown.setRangeText("  ", start, end, "end");
      }
      edited();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  if (!supported) {
    ui.compatibility.textContent = "Este navegador não oferece acesso de escrita a pastas. Abra o app em Chrome ou Edge atualizado, em http://localhost:4173.";
    notify("File System Access API indisponível. Use Chrome ou Edge em localhost (ou HTTPS).", true);
  } else if (!librariesReady) {
    notify("As bibliotecas Marked.js e DOMPurify não foram carregadas. Confira os arquivos da pasta vendor e recarregue a página.", true);
  }
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
  updateControls();
  restoreLastSelection();
})();
