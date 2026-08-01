// Genera sitemap.xml y robots.txt a partir del catálogo que está publicado
// AHORA en el backend. Se corre a mano cuando el catálogo cambia bastante:
//
//     node sitemap.mjs
//
// Por qué hace falta un sitemap acá y no en cualquier sitio: esta página es
// una sola pantalla que arma todo con JavaScript. Las tarjetas de producto y
// los botones del menú no son enlaces <a href>, son divs con onclick, así que
// un buscador no tiene por dónde entrar a las fichas. El sitemap es la lista
// explícita de direcciones para que Google las visite igual.
//
// Sólo entran productos CON stock: si no se puede comprar, no corresponde
// ofrecerlo en el buscador. Un resultado que lleva a "sin stock" es una visita
// perdida y le enseña a Google que el sitio decepciona.

import { writeFileSync } from 'node:fs';

const SITIO   = 'https://www.distribuidoralabarata.cl';
const API     = 'https://labarata-backend.onrender.com/api/productos';
const HOY     = new Date().toISOString().slice(0, 10);

// Nombres de las categorías, para ordenarlas por importancia comercial. Las
// que no estén acá igual entran, al final: vale más una URL de más que una
// categoría nueva que quede invisible por olvido.
const PRIORIDAD_CAT = ['ofertas', 'despensa', 'lacteos', 'aseo', 'bebidas',
                       'panaderia', 'congelados', 'mascotas', 'bazar'];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const url = (loc, prio, freq) =>
  `  <url>\n    <loc>${esc(SITIO + loc)}</loc>\n` +
  `    <lastmod>${HOY}</lastmod>\n` +
  `    <changefreq>${freq}</changefreq>\n` +
  `    <priority>${prio}</priority>\n  </url>`;

// La API entrega de a 50 y avisa el total. Hay que pedir las páginas
// siguientes: la primera vez el sitemap salió con 50 productos de 115 porque
// se tomó la primera tanda como si fuera todo el catálogo.
const productos = [];
let total = Infinity;
for (let offset = 0; productos.length < total; offset += 50) {
  const r = await fetch(`${API}?limit=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
  const d = await r.json();
  const tanda = Array.isArray(d) ? d : (d.productos || d.data || []);
  if (typeof d.total === 'number') total = d.total;
  if (!tanda.length) break;
  productos.push(...tanda);
  if (Array.isArray(d)) break;             // API sin paginación: vino todo junto
}
if (!productos.length) throw new Error('el backend no devolvió productos');
if (productos.length < total) throw new Error(`faltaron productos: ${productos.length} de ${total}`);

// Con stock y con una dirección utilizable. El ?p= del sitio busca por barCode
// o por code, así que sirve cualquiera de los dos, pero se prefiere el barcode
// porque es el que no cambia si algún día se rehace el SKU.
const vivos = productos.filter(p => {
  const st = Number(p.stock);
  return (p.barCode || p.code) && (isNaN(st) ? true : st > 0);
});

const cats = [...new Set(vivos.map(p => p.c || p.categoria).filter(Boolean))]
  .sort((a, b) => {
    const ia = PRIORIDAD_CAT.indexOf(a), ib = PRIORIDAD_CAT.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

const partes = [url('/', '1.0', 'daily')];

// Las categorías van con prioridad alta: son las páginas que de verdad
// queremos que salgan cuando alguien busca "detergente valdivia".
for (const c of cats) partes.push(url(`/?c=${encodeURIComponent(c)}`, '0.8', 'daily'));

// Subcategorías, si la planilla las tiene cargadas.
const subs = new Set();
for (const p of vivos) {
  const c = p.c || p.categoria, s = p.sub;
  if (c && s) subs.add(`${c}|${s}`);
}
for (const par of [...subs].sort()) {
  const [c, s] = par.split('|');
  partes.push(url(`/?c=${encodeURIComponent(c)}&s=${encodeURIComponent(s)}`, '0.6', 'weekly'));
}

// Fichas de producto. changefreq weekly y no daily: el precio cambia, pero
// decirle "daily" a todo hace que Google deje de creerle al archivo entero.
for (const p of vivos) {
  partes.push(url(`/?p=${encodeURIComponent(p.barCode || p.code)}`, '0.5', 'weekly'));
}

writeFileSync('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  partes.join('\n') + '\n</urlset>\n', 'utf8');

writeFileSync('robots.txt',
`# Distribuidora La Barata — Valdivia
# Se puede indexar todo: es una tienda, mientras más se vea mejor.

User-agent: *
Allow: /

# Direcciones que no aportan nada en el buscador y sólo repiten contenido:
# el carro y el retorno del pago no son páginas para llegar desde Google.
Disallow: /?pago=
Disallow: /?orden=

Sitemap: ${SITIO}/sitemap.xml
`, 'utf8');

console.log(`sitemap.xml  ->  ${partes.length} direcciones`);
console.log(`   1 portada`);
console.log(`   ${cats.length} categorías: ${cats.join(', ')}`);
console.log(`   ${subs.size} subcategorías`);
console.log(`   ${vivos.length} productos con stock (de ${productos.length} publicados)`);
console.log(`robots.txt   ->  apunta a ${SITIO}/sitemap.xml`);
