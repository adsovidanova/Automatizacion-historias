const { chromium } = require("playwright");
const readline = require("readline");

const URL_INICIAL = "https://www.siisa.com.co";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext({
    viewport: { width: 1276, height: 715 },
  });
  const paginaInicial = await context.newPage();

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const preguntar = (m) => new Promise((r) => terminal.question(m, r));

  try {
    await paginaInicial.goto(URL_INICIAL);
    await preguntar(
      "Inicia sesión manualmente. Cuando estés en la pantalla principal, pulsa Enter aquí.\n"
    );

    const paginas = context.pages();
    const page = paginas[paginas.length - 1];
    await page.bringToFront();

    // SOLO LECTURA: no hace clic. Describe el elemento en la esquina
    // superior izquierda y sus 5 ancestros, sin textos, enlaces ni src.
    const info = await page.evaluate(() => {
      const describir = (el) => ({
        etiqueta: el.tagName.toLowerCase(),
        id: el.id || null,
        clases: el.className && typeof el.className === "string" ? el.className : null,
        role: el.getAttribute("role"),
        ariaLabel: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        alt: el.getAttribute("alt"),
        tieneHref: el.hasAttribute("href"),
        tieneOnclick: el.hasAttribute("onclick"),
        tieneSrc: el.hasAttribute("src"),
      });

      const puntos = [
        [22, 17],
        [22, 30],
        [40, 20],
      ];
      return puntos.map(([x, y]) => {
        let el = document.elementFromPoint(x, y);
        const cadena = [];
        for (let i = 0; el && i < 6; i++) {
          cadena.push(describir(el));
          el = el.parentElement;
        }
        return { punto: `${x},${y}`, cadena };
      });
    });

    console.log(JSON.stringify(info, null, 2));
    console.log("\nCopia todo lo anterior y pégalo en el chat.");
    await preguntar("Pulsa Enter para cerrar el navegador.\n");
  } catch (error) {
    console.log("El script se detuvo:", error.message);
    await preguntar("Pulsa Enter para cerrar el navegador.\n");
  } finally {
    terminal.close();
    await browser.close();
  }
})();