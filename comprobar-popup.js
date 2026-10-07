const { chromium } = require("playwright");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const URL_INICIAL = "https://www.siisa.com.co";

// Los PDF tienen datos clínicos: se guardan FUERA de OneDrive.
const CARPETA_BASE = path.join(os.homedir(), "SIISA_descargas");
const MAX_DOCUMENTOS = 200; // tope de seguridad por paciente
const MAX_PAGINAS_POR_CARPETA = 30;
const ESPERA_CAMBIO_MS = 6000;

// "doble" = doble clic rápido | "dos" = dos clics separados con una pausa
const MODO_CLIC = "dos";

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 1276, height: 715 },
  });
  const paginaInicial = await context.newPage();

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const preguntar = (mensaje) =>
    new Promise((resolve) => terminal.question(mensaje, resolve));

  // Huella (hash) del último documento buscado. Se guarda el hash, no el número.
  let ultimaFirmaDocumento = null;

  // ---------- Utilidades generales ----------

  const urlSegura = (p) => {
    try {
      const u = new URL(p.url());
      return u.origin + u.pathname;
    } catch {
      return "(sin URL)";
    }
  };

  const msgSeguro = (e) =>
    String(e && e.message ? e.message : e)
      .split("\n")[0]
      .replace(/https?:\/\/\S+/g, "(URL)");

  const msgDetalle = (e) =>
    String(e && e.message ? e.message : e)
      .split("\n")
      .slice(0, 8)
      .join("\n      ")
      .replace(/https?:\/\/\S+/g, "(URL)");

  const hash = (texto) => crypto.createHash("sha1").update(texto).digest("hex");

  const limpiarNombre = (t) =>
    t
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "carpeta";

  async function conReintentos(fn, intentos = 3, esperaMs = 2000) {
    let ultimo;
    for (let i = 1; i <= intentos; i++) {
      try {
        return await fn();
      } catch (e) {
        ultimo = e;
        const transitorio = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|Timeout|no aparece|no encontré el árbol/i.test(
          String(e && e.message ? e.message : e)
        );
        if (!transitorio || i === intentos) break;
        await new Promise((r) => setTimeout(r, esperaMs * i));
      }
    }
    throw ultimo;
  }

  async function clicRobusto(nodo) {
    try {
      await nodo.click({ timeout: 4000 });
      return;
    } catch {}
    try {
      await nodo.click({ force: true, timeout: 3000 });
      return;
    } catch {}
    await nodo.dispatchEvent("click", {}, { timeout: 3000 });
  }

  async function unicoVisible(localizador, nombre) {
    const total = await localizador.count();
    const visibles = [];
    for (let i = 0; i < total; i++) {
      if (await localizador.nth(i).isVisible()) visibles.push(localizador.nth(i));
    }
    console.log(`  [${nombre}] ${total} coincidencia(s), ${visibles.length} visible(s)`);
    return visibles.length === 1 ? visibles[0] : null;
  }

  async function esperarUnicoVisible(localizador, nombre, ms) {
    const limite = Date.now() + ms;
    while (Date.now() < limite) {
      const el = await unicoVisible(localizador, nombre);
      if (el) return el;
      await localizador.page().waitForTimeout(500);
    }
    return null;
  }

  async function listarTextosVisibles(page) {
    const textos = await page.evaluate(() => {
      const vistos = new Set();
      document.querySelectorAll("a, li, span, button").forEach((el) => {
        const r = el.getBoundingClientRect();
        const t = (el.innerText || "").trim();
        if (r.width > 0 && r.height > 0 && t && t.length <= 30 && !t.includes("\n")) {
          vistos.add(t);
        }
      });
      return [...vistos].slice(0, 60);
    });
    console.log("Textos cortos visibles en pantalla:", textos.join(" | "));
  }

  async function describirCamposVisibles(page) {
    console.log(`Marcos (iframes) en la página: ${page.frames().length - 1}`);
    const info = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const desc = (el) => ({
        etiqueta: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        id: el.id || null,
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
        ariaLabel: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        clases: typeof el.className === "string" ? el.className : null,
        textoBoton:
          el.tagName === "BUTTON" || el.type === "button" || el.type === "submit"
            ? (el.innerText || "").trim().slice(0, 30) || null
            : null,
      });
      return [...document.querySelectorAll("input, textarea, button, select")]
        .filter(visible)
        .slice(0, 30)
        .map(desc);
    });
    console.log("Campos y botones visibles:");
    console.log(JSON.stringify(info, null, 2));
  }

  async function describirCelda(celda) {
    const info = await celda.evaluate((td) => {
      const desc = (el) => ({
        etiqueta: el.tagName.toLowerCase(),
        id: el.id || null,
        clases: typeof el.className === "string" ? el.className : null,
        alt: el.getAttribute("alt"),
        title: el.getAttribute("title"),
        ariaLabel: el.getAttribute("aria-label"),
        type: el.getAttribute("type"),
        tieneHref: el.hasAttribute("href"),
        tieneOnclick: el.hasAttribute("onclick"),
        tieneSrc: el.hasAttribute("src"),
      });
      return [td, ...td.querySelectorAll("*")].slice(0, 10).map(desc);
    });
    console.log("Contenido de la celda del ícono (sin textos ni enlaces):");
    console.log(JSON.stringify(info, null, 2));
  }

  // ---------- Árbol de carpetas (izquierda del Histórico) ----------

  async function marcarHojas(pagina) {
    for (const marco of pagina.frames()) {
      let r = null;
      try {
        r = await marco.evaluate(() => {
          document
            .querySelectorAll("[data-pw-hoja]")
            .forEach((e) => e.removeAttribute("data-pw-hoja"));
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const candidatos = [...document.querySelectorAll("a, span, div, td, li")].filter(
            (el) =>
              norm(el.textContent) === "Consulta Externa" &&
              ![...el.children].some((h) => norm(h.textContent) === "Consulta Externa")
          );
          if (candidatos.length === 0) return null;
          const li = candidatos[0].closest("li");
          if (!li || !li.parentElement) return { ok: false };
          const raiz = li.parentElement;
          const hojas = [...raiz.querySelectorAll("li")].filter((x) => !x.querySelector("li"));
          const etiquetas = [];
          hojas.forEach((h, i) => {
            const a = h.querySelector(":scope > a") || h.querySelector("a") || h.querySelector("span");
            if (a) a.setAttribute("data-pw-hoja", String(i));
            etiquetas.push(norm(a ? a.textContent : ""));
          });
          return { ok: true, etiquetas };
        });
      } catch {
        continue;
      }
      if (r) return { marco, ...r };
    }
    return null;
  }

  async function describirAncestros(pagina) {
    for (const marco of pagina.frames()) {
      const loc = marco.getByText("Consulta Externa", { exact: true });
      if ((await loc.count()) === 0) continue;
      const cadena = await loc.first().evaluate((el) => {
        const r = [];
        let x = el;
        for (let i = 0; x && i < 8; i++) {
          r.push({
            etiqueta: x.tagName.toLowerCase(),
            id: x.id || null,
            clases: typeof x.className === "string" ? x.className : null,
            tieneHref: x.hasAttribute("href"),
          });
          x = x.parentElement;
        }
        return r;
      });
      console.log("Estructura alrededor de 'Consulta Externa':");
      console.log(JSON.stringify(cadena, null, 2));
      return;
    }
    console.log("No encontré el texto 'Consulta Externa' en ningún marco.");
  }

  // Fuerza todas las ramas abiertas con CSS y bloquea los eventos de salida del
  // mouse para que el árbol no se oculte. Devuelve cuántas listas siguen ocultas.
  async function expandirArbol(pagina) {
    const h = await marcarHojas(pagina);
    if (!h || !h.ok) throw new Error("No encontré el árbol de carpetas.");

    await h.marco.evaluate(() => {
      if (!window.__pwSinOcultar) {
        window.__pwSinOcultar = true;
        ["mouseleave", "mouseout", "pointerleave", "pointerout"].forEach((tipo) => {
          window.addEventListener(tipo, (ev) => ev.stopImmediatePropagation(), true);
        });
      }
      if (!document.getElementById("pw-expandir")) {
        const s = document.createElement("style");
        s.id = "pw-expandir";
        s.textContent =
          "li > ul { display: block !important; visibility: visible !important; " +
          "height: auto !important; opacity: 1 !important; overflow: visible !important; }";
        document.head.appendChild(s);
      }
      document.querySelectorAll("li.closed").forEach((li) => {
        li.classList.remove("closed");
        li.classList.add("open");
      });
    });

    return await h.marco.evaluate(
      () =>
        [...document.querySelectorAll("li > ul")].filter((u) => {
          if (!u.querySelector("li")) return false;
          const r = u.getBoundingClientRect();
          return r.width === 0 || r.height === 0;
        }).length
    );
  }

  // ---------- Panel derecho (tabla con columna "Visualizar") ----------

  async function buscarTablaDocumentos(pagina) {
    for (const marco of pagina.frames()) {
      const enc = marco.locator("th").filter({ hasText: /^\s*Visualizar\s*$/i });
      const total = await enc.count().catch(() => 0);
      for (let i = 0; i < total; i++) {
        if (await enc.nth(i).isVisible().catch(() => false)) {
          return { marco, encabezado: enc.nth(i) };
        }
      }
    }
    return null;
  }

  async function firmaPanel(pagina) {
    let texto = "";
    for (const marco of pagina.frames()) {
      try {
        texto += await marco.evaluate(() => (document.body ? document.body.innerText : ""));
      } catch {
        return "error";
      }
    }
    return hash(texto);
  }

  async function esperarCambioYEstabilidad(pagina, firmaAnterior) {
    const limite = Date.now() + ESPERA_CAMBIO_MS;
    let actual = firmaAnterior;
    while (Date.now() < limite) {
      actual = await firmaPanel(pagina);
      if (actual !== firmaAnterior) break;
      await pagina.waitForTimeout(400);
    }
    let previa = null;
    for (let i = 0; i < 15; i++) {
      actual = await firmaPanel(pagina);
      if (actual === previa && actual !== "error") break;
      previa = actual;
      await pagina.waitForTimeout(700);
    }
    return actual;
  }

  async function prepararNodo(pagina, indice, etiqueta) {
    await expandirArbol(pagina);
    const h = await marcarHojas(pagina);
    if (!h || !h.ok) throw new Error("No encontré el árbol de carpetas.");
    const pos = h.etiquetas[indice] === etiqueta ? indice : h.etiquetas.indexOf(etiqueta);
    if (pos < 0) throw new Error("La carpeta ya no aparece en el árbol.");
    return h.marco.locator(`[data-pw-hoja="${pos}"]`);
  }

  async function abrirCarpeta(pagina, indice, etiqueta) {
    const antes = await firmaPanel(pagina);
    await pagina.bringToFront();
    let nodo = await prepararNodo(pagina, indice, etiqueta);
    try {
      if (MODO_CLIC === "doble") {
        await nodo.dblclick({ timeout: 10000 });
      } else {
        await clicRobusto(nodo);
        await pagina.waitForTimeout(600);
        nodo = await prepararNodo(pagina, indice, etiqueta);
        await clicRobusto(nodo);
      }
    } catch (e) {
      const d = await nodo
        .evaluate(
          (el) => {
            const r = el.getBoundingClientRect();
            const ocultosPor = [];
            let x = el.parentElement;
            while (x && ocultosPor.length < 6) {
              const s = getComputedStyle(x);
              if (s.display === "none" || s.visibility === "hidden") {
                ocultosPor.push(x.tagName.toLowerCase() + (x.className ? "." + x.className : ""));
              }
              x = x.parentElement;
            }
            const encima = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              etiqueta: el.tagName.toLowerCase(),
              ancho: Math.round(r.width),
              alto: Math.round(r.height),
              ocultoPorAncestro: ocultosPor,
              elementoEncima: encima
                ? encima.tagName.toLowerCase() + (encima.className ? "." + encima.className : "")
                : null,
            };
          },
          null,
          { timeout: 2000 }
        )
        .catch(() => null);
      console.log("    Diagnóstico del nodo:", JSON.stringify(d));
      throw e;
    }
    await esperarCambioYEstabilidad(pagina, antes);
  }

  async function elegirIcono(celda) {
    const enlaces = celda.locator("a");
    const imagenes = celda.locator("img");
    const nE = await enlaces.count();
    const nI = await imagenes.count();
    if (nE === 1) return { icono: enlaces.first() };
    if (nE === 0 && nI === 1) return { icono: imagenes.first() };
    if (nE === 0 && nI === 0) return {};
    return { ambiguo: true };
  }

  async function buscarSiguiente(marco) {
    const candidatos = [
      marco.locator('a[title*="Next" i], a[title*="Siguiente" i]'),
      marco.locator('a:has(img[alt*="Next" i]), a:has(img[alt*="Siguiente" i])'),
      marco.locator('a[class*="next" i]'),
    ];
    for (const loc of candidatos) {
      const total = await loc.count().catch(() => 0);
      const visibles = [];
      for (let i = 0; i < total; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) visibles.push(loc.nth(i));
      }
      if (visibles.length === 1) return visibles[0];
    }
    return null;
  }

  async function guardarPdfDeFila(pagina, icono, rutaArchivo) {
    await pagina.bringToFront();
    const espera = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
    await icono.click({ timeout: 10000 });
    const nueva = await espera;
    if (!nueva) throw new Error("El clic no abrió una pestaña nueva.");
    try {
      let url = nueva.url();
      const limite = Date.now() + 20000;
      while ((!url || url === "about:blank") && Date.now() < limite) {
        await pagina.waitForTimeout(300);
        url = nueva.url();
      }
      if (!url || url === "about:blank") {
        throw new Error("La pestaña nueva no cargó ninguna dirección.");
      }
      const resp = await conReintentos(
        () => context.request.get(url, { timeout: 60000 }),
        4,
        3000
      );
      if (!resp.ok()) throw new Error(`Respuesta HTTP ${resp.status()} al pedir el PDF.`);
      const cuerpo = await resp.body();
      if (cuerpo.subarray(0, 5).toString("latin1") !== "%PDF-") {
        throw new Error("La respuesta no parece un PDF (¿sesión vencida?).");
      }
      fs.writeFileSync(rutaArchivo, cuerpo);
      return cuerpo.length;
    } finally {
      await nueva.close().catch(() => {});
    }
  }

  async function recorrerCarpeta(pagina, opc) {
    const { descargar, vistos, nombreCarpeta, dirSalida, estado } = opc;
    const r = { encontrados: 0, descargados: 0, fallos: 0, ambiguas: 0, paginas: 0, sinTabla: false };

    for (let pag = 1; pag <= MAX_PAGINAS_POR_CARPETA; pag++) {
      const tabla = await buscarTablaDocumentos(pagina);
      if (!tabla) {
        if (pag === 1) r.sinTabla = true;
        break;
      }
      r.paginas++;
      const indice = await tabla.encabezado.evaluate((th) =>
        Array.from(th.parentElement.children).indexOf(th)
      );
      const filas = tabla.encabezado
        .locator("xpath=ancestor::table[1]")
        .locator("tr:has(> td)");
      const total = await filas.count();

      const pendientes = [];
      for (let i = 0; i < total; i++) {
        const fila = filas.nth(i);
        if (!(await fila.isVisible())) continue;
        const celda = fila.locator("> td").nth(indice);
        const { icono, ambiguo } = await elegirIcono(celda);
        if (ambiguo) {
          r.ambiguas++;
          continue;
        }
        if (!icono) continue;
        const firma = hash(await fila.innerText());
        if (vistos.has(firma)) continue;
        vistos.add(firma);
        pendientes.push(i);
      }
      r.encontrados += pendientes.length;

      if (descargar) {
        for (const i of pendientes) {
          if (estado.descargados >= MAX_DOCUMENTOS) {
            console.log("    Límite de seguridad alcanzado.");
            return r;
          }
          if (estado.fallosSeguidos >= 3) {
            throw new Error("3 fallos seguidos al descargar. Me detengo.");
          }
          const celda = filas.nth(i).locator("> td").nth(indice);
          const { icono } = await elegirIcono(celda);
          const nombre = `${String(estado.descargados + 1).padStart(3, "0")}_${limpiarNombre(nombreCarpeta)}.pdf`;
          try {
            if (!icono) throw new Error("El ícono ya no está en la fila.");
            const bytes = await guardarPdfDeFila(pagina, icono, path.join(dirSalida, nombre));
            estado.descargados++;
            estado.fallosSeguidos = 0;
            r.descargados++;
            console.log(`    OK ${nombre} (${Math.round(bytes / 1024)} KB)`);
          } catch (e) {
            r.fallos++;
            estado.fallosSeguidos++;
            console.log(`    FALLÓ un documento: ${msgSeguro(e)}`);
          }
          await pagina.waitForTimeout(800);
        }
      }

      const siguiente = await buscarSiguiente(tabla.marco);
      if (!siguiente) break;
      const antes = await firmaPanel(pagina);
      await siguiente.click({ timeout: 10000 });
      const despues = await esperarCambioYEstabilidad(pagina, antes);
      if (despues === antes) break;
    }
    return r;
  }

  // ---------- Navegación hasta la búsqueda de pacientes ----------

  // Menú -> Asistencial -> Pacientes.
  async function irAPacientes(page) {
    console.log("Buscando el ícono del menú (#button-menu img)...");
    const menu = await esperarUnicoVisible(page.locator("#button-menu img"), "menú", 15000);
    if (!menu) {
      throw new Error("No encontré el ícono del menú. ¿Estás en la pantalla principal?");
    }
    await menu.click();

    console.log("Buscando Asistencial...");
    const asistencial = await esperarUnicoVisible(
      page.getByText("Asistencial", { exact: true }),
      "Asistencial",
      15000
    );
    if (!asistencial) {
      await listarTextosVisibles(page);
      throw new Error("No encontré un único 'Asistencial' visible.");
    }
    await asistencial.click();

    console.log("Buscando Pacientes...");
    const locPacientes = page.getByText("Pacientes", { exact: true });
    let pacientes = await esperarUnicoVisible(locPacientes, "Pacientes", 4000);
    if (!pacientes) {
      console.log("No apareció con clic. Pruebo pasando el mouse sobre Asistencial...");
      await asistencial.hover();
      pacientes = await esperarUnicoVisible(locPacientes, "Pacientes", 6000);
    }
    if (!pacientes) {
      await listarTextosVisibles(page);
      throw new Error("No encontré un único 'Pacientes' visible.");
    }
    await pacientes.click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    console.log(`Pantalla actual: ${urlSegura(page)}`);
  }

  // Devuelve el único cuadro de búsqueda visible, o null.
  async function buscarCuadro(page) {
    const candidatos = [
      {
        descripcion: "input con 'search' en el id",
        loc: page.locator('input[type="text"][id*="search" i]'),
      },
      {
        descripcion: "input con 'search' en la clase",
        loc: page.locator('input[type="text"][class*="search" i]'),
      },
      {
        descripcion: "input con 'search' en el name",
        loc: page.locator('input[type="text"][name*="search" i]'),
      },
    ];
    for (const { descripcion, loc } of candidatos) {
      const cuadro = await unicoVisible(loc, descripcion);
      if (cuadro) {
        console.log(`  -> Usando: ${descripcion}`);
        return cuadro;
      }
    }
    return null;
  }

  // ---------- Proceso completo de UN paciente ----------

  async function procesarPaciente(page, primera) {
    // --- Cuadro de búsqueda ---
    console.log("Buscando el cuadro de búsqueda...");
    let cuadro = null;
    if (!primera) {
      // Si seguimos en la pantalla de Pacientes, se reutiliza.
      cuadro = await buscarCuadro(page);
    }
    if (!cuadro) {
      await irAPacientes(page);
      cuadro = await buscarCuadro(page);
    }
    if (!cuadro) {
      await describirCamposVisibles(page);
      throw new Error(
        "No encontré un único cuadro de búsqueda. Copia la lista 'Campos y botones visibles' de arriba."
      );
    }

    // --- Pedir el documento por terminal (no se imprime) ---
    let documento = "";
    while (!/^\d{4,15}$/.test(documento)) {
      documento = (
        await preguntar(
          "Escribe el número de documento (solo dígitos, de un registro autorizado) y pulsa Enter:\n"
        )
      ).trim();
      if (!/^\d{4,15}$/.test(documento)) {
        console.log("Formato no válido. Usa solo dígitos (entre 4 y 15).");
      }
    }
    const firmaDoc = hash(documento);

    // Huella de la pantalla ANTES de buscar, para saber cuándo cambian los resultados.
    const firmaAntes = await firmaPanel(page);

    await cuadro.click();
    await cuadro.fill(documento);
    documento = "";
    console.log("Documento escrito en el cuadro. Buscando...");

    const botonGo = await unicoVisible(
      page.getByRole("button", { name: "Go", exact: true }),
      "botón Go"
    );
    if (botonGo) {
      await botonGo.click();
    } else {
      console.log("No encontré un único botón Go. Pruebo con Enter...");
      await cuadro.press("Enter");
    }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Protección: si el documento es distinto al anterior, los resultados deben
    // haber cambiado. Así no se hace clic sobre la fila del paciente anterior.
    if (firmaDoc !== ultimaFirmaDocumento) {
      let cambio = false;
      const limiteCambio = Date.now() + 15000;
      while (Date.now() < limiteCambio) {
        if ((await firmaPanel(page)) !== firmaAntes) {
          cambio = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (!cambio) {
        throw new Error(
          "Los resultados no cambiaron tras la búsqueda. No hago clic para no abrir el paciente equivocado."
        );
      }
      await esperarCambioYEstabilidad(page, firmaAntes);
    }
    ultimaFirmaDocumento = firmaDoc;

    // --- Ubicar la columna "Histórico de Atenciones" ---
    console.log("Buscando la columna 'Histórico de Atenciones'...");
    const encabezado = await esperarUnicoVisible(
      page.locator("th").filter({ hasText: /Hist[oó]rico\s+de\s+Atenciones/i }),
      "encabezado Histórico",
      15000
    );
    if (!encabezado) {
      throw new Error(
        "No encontré un único encabezado 'Histórico de Atenciones' visible. ¿Quedó la tabla de resultados en pantalla?"
      );
    }

    const tabla = encabezado.locator("xpath=ancestor::table[1]");
    const indiceColumna = await encabezado.evaluate((th) =>
      Array.from(th.parentElement.children).indexOf(th)
    );
    console.log(`  Columna encontrada (posición ${indiceColumna + 1}).`);

    // --- Verificar que quedó EXACTAMENTE una fila ---
    const filas = tabla.locator("tr:has(> td)");
    let cantidadFilas = 0;
    const limiteFilas = Date.now() + 15000;
    while (Date.now() < limiteFilas) {
      cantidadFilas = 0;
      const total = await filas.count();
      for (let i = 0; i < total; i++) {
        if (await filas.nth(i).isVisible()) cantidadFilas++;
      }
      if (cantidadFilas === 1) break;
      await page.waitForTimeout(500);
    }
    console.log(`  Filas de resultados visibles: ${cantidadFilas}`);
    if (cantidadFilas !== 1) {
      throw new Error(
        `Se esperaba exactamente 1 fila y hay ${cantidadFilas}. No hago clic para no abrir el paciente equivocado.`
      );
    }

    // --- Ícono dentro de la celda ---
    const fila = filas.first();
    const celda = fila.locator("> td").nth(indiceColumna);

    const candidatosIcono = [
      { descripcion: "enlace <a> en la celda", loc: celda.locator("a") },
      {
        descripcion: "botón o input de imagen en la celda",
        loc: celda.locator("button, input[type='image']"),
      },
      { descripcion: "imagen <img> en la celda", loc: celda.locator("img") },
    ];

    let icono = null;
    for (const { descripcion, loc } of candidatosIcono) {
      icono = await unicoVisible(loc, descripcion);
      if (icono) {
        console.log(`  -> Usando: ${descripcion}`);
        break;
      }
    }
    if (!icono) {
      await describirCelda(celda);
      throw new Error(
        "No encontré un único ícono clicable en esa celda. Copia el JSON de arriba (no contiene textos ni enlaces)."
      );
    }

    // --- Clic en el ícono (el Histórico se abre en pestaña nueva) ---
    const esperaPestana = context
      .waitForEvent("page", { timeout: 5000 })
      .catch(() => null);

    console.log("Haciendo clic en 'Histórico de Atenciones'...");
    await icono.click();

    const pestanaNueva = await esperaPestana;
    let paginaHistorico = page;
    if (pestanaNueva) {
      await pestanaNueva.waitForLoadState("domcontentloaded").catch(() => {});
      await pestanaNueva.bringToFront();
      paginaHistorico = pestanaNueva;
      console.log(`Se abrió una pestaña nueva: ${urlSegura(pestanaNueva)}`);
    } else {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      console.log(`No se abrió pestaña nueva. Pantalla actual: ${urlSegura(page)}`);
    }

    // --- Árbol de carpetas ---
    console.log("Buscando el árbol de carpetas (Consulta Externa, Consultas, ...)...");
    let hojas = null;
    const limiteArbol = Date.now() + 20000;
    while (Date.now() < limiteArbol) {
      hojas = await marcarHojas(paginaHistorico);
      if (hojas && hojas.ok) break;
      await paginaHistorico.waitForTimeout(1000);
    }
    if (!hojas || !hojas.ok) {
      await describirAncestros(paginaHistorico);
      throw new Error(
        "No pude identificar los nodos finales del árbol. Copia la 'Estructura alrededor de Consulta Externa' de arriba."
      );
    }
    const etiquetas = hojas.etiquetas;
    console.log(`  Carpetas finales detectadas: ${etiquetas.length}`);
    etiquetas.forEach((e, i) => console.log(`   ${i + 1}. ${e || "(sin nombre)"}`));
    console.log(`  Modo de clic en carpetas: ${MODO_CLIC}`);

    console.log("\nDesplegando todas las ramas del árbol...");
    const ocultas = await expandirArbol(paginaHistorico);
    console.log(`  Ramas aún ocultas: ${ocultas} (debería ser 0).`);
    await preguntar(
      "Mira la ventana del Histórico: ¿el árbol quedó completamente desplegado?\n" +
        "Si sí, pulsa Enter para empezar a contar documentos (Ctrl+C para cancelar).\n"
    );

    // --- FASE 1: contar documentos por carpeta (NO descarga) ---
    console.log("\nFASE 1: contando documentos en cada carpeta (no descarga nada)...");
    const vistosConteo = new Set();
    const resumen = [];
    for (let i = 0; i < etiquetas.length; i++) {
      const et = etiquetas[i];
      console.log(`- [${i + 1}/${etiquetas.length}] ${et}`);
      try {
        await conReintentos(() => abrirCarpeta(paginaHistorico, i, et), 2, 2000);
        const r = await recorrerCarpeta(paginaHistorico, {
          descargar: false,
          vistos: vistosConteo,
          nombreCarpeta: et,
        });
        resumen.push({ i, et, ...r });
      } catch (e) {
        console.log(`    No pude revisar esta carpeta: ${msgDetalle(e)}`);
        resumen.push({ i, et, encontrados: 0, error: true, msg: msgSeguro(e) });
      }
    }

    console.log("\nRESUMEN (documentos con ícono en la columna 'Visualizar'):");
    for (const x of resumen) {
      const notas = [];
      if (x.sinTabla) notas.push("sin tabla 'Visualizar'");
      if (x.ambiguas) notas.push(`${x.ambiguas} fila(s) con ícono ambiguo`);
      if (x.error) notas.push("error al revisar: " + x.msg);
      if (x.paginas > 1) notas.push(`${x.paginas} páginas`);
      console.log(
        `  ${x.et}: ${x.encontrados}${notas.length ? "  (" + notas.join("; ") + ")" : ""}`
      );
    }
    const conDocs = resumen.filter((x) => x.encontrados > 0);
    const totalDocs = conDocs.reduce((s, x) => s + x.encontrados, 0);
    console.log(`TOTAL: ${totalDocs} documento(s) en ${conDocs.length} carpeta(s).`);
    console.log(
      "Compara este resumen con lo que ves en pantalla (en especial si hay varias páginas) antes de continuar."
    );

    if (totalDocs === 0) {
      console.log("No hay nada que descargar para este paciente.");
      return;
    }

    // --- Confirmación ---
    const aviso =
      totalDocs > MAX_DOCUMENTOS ? ` (se descargarán como máximo ${MAX_DOCUMENTOS})` : "";
    const resp = (
      await preguntar(
        `\n¿Descargar ${totalDocs} documento(s)${aviso} en ${CARPETA_BASE}? (s/n): `
      )
    )
      .trim()
      .toLowerCase();
    if (resp !== "s") {
      console.log("No se descargó nada para este paciente.");
      return;
    }

    // --- FASE 2: descarga ---
    const dirSalida = path.join(
      CARPETA_BASE,
      "paciente_" + new Date().toISOString().replace(/[:.]/g, "-")
    );
    fs.mkdirSync(dirSalida, { recursive: true });
    console.log(`\nFASE 2: descargando en ${dirSalida}`);

    const estado = { descargados: 0, fallosSeguidos: 0 };
    const vistosDescarga = new Set();
    let totalFallos = 0;

    for (const c of conDocs) {
      if (estado.descargados >= MAX_DOCUMENTOS) break;
      console.log(`- ${c.et}`);
      try {
        await conReintentos(() => abrirCarpeta(paginaHistorico, c.i, c.et), 2, 2000);
        const r = await recorrerCarpeta(paginaHistorico, {
          descargar: true,
          vistos: vistosDescarga,
          nombreCarpeta: c.et,
          dirSalida,
          estado,
        });
        totalFallos += r.fallos;
        if (r.encontrados !== c.encontrados) {
          console.log(
            `    Aviso: en el conteo había ${c.encontrados} y ahora ${r.encontrados}.`
          );
        }
      } catch (e) {
        console.log(`    Error en esta carpeta: ${msgDetalle(e)}`);
        if (estado.fallosSeguidos >= 3) break;
      }
    }

    console.log(
      `\nTerminado este paciente. Descargados: ${estado.descargados}. Fallos: ${totalFallos}. Carpeta: ${dirSalida}`
    );
  }

  // ---------- Flujo principal (bucle de pacientes) ----------

  try {
    await paginaInicial.goto(URL_INICIAL);

    await preguntar(
      "Inicia sesión manualmente. Cuando estés en la pantalla principal de SIISA, pulsa Enter aquí.\n"
    );

    const paginas = context.pages();
    console.log(`Pestañas abiertas: ${paginas.length}`);
    paginas.forEach((p, i) => console.log(`  ${i + 1}. ${urlSegura(p)}`));
    const page = paginas[paginas.length - 1];
    await page.bringToFront();

    let primera = true;
    let seguir = true;
    while (seguir) {
      const abiertasAntes = new Set(context.pages());

      try {
        await procesarPaciente(page, primera);
      } catch (e) {
        console.log("No se pudo completar este paciente:", msgDetalle(e));
      }
      primera = false;

      // Cierra las pestañas que se abrieron durante este paciente (Histórico, etc.).
      for (const p of context.pages()) {
        if (!abiertasAntes.has(p)) await p.close().catch(() => {});
      }
      await page.bringToFront().catch(() => {});

      const otra = (await preguntar("\n¿Consultar otro paciente? (s/n): "))
        .trim()
        .toLowerCase();
      if (otra !== "s") seguir = false;
    }

    await preguntar("Pulsa Enter para cerrar el navegador.\n");
  } catch (error) {
    console.log("El script se detuvo:", msgDetalle(error));
    await preguntar("Pulsa Enter para cerrar el navegador.\n");
  } finally {
    terminal.close();
    await browser.close();
  }
})();
