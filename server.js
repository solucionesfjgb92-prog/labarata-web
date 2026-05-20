// ══════════════════════════════════════════════════
//  SERVIDOR BACKEND — Distribuidora La Barata v7.0
//  Fuente de datos: Google Sheets (CSV público)
//  Sin Bsale — gestión simple desde planilla
// ══════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }));
app.use('/imagenes', express.static('IMAGENES PRODUCTOS'));

// ── URL del Google Sheets publicado como CSV ──────
const SHEETS_URL = process.env.SHEETS_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTxs_HEpIQwQ2GqbvBDHUwKAtvbz9YDliZE8JdPeOeBMUkLAnk6jW7unzIfkd8cGg/pub?gid=292915002&single=true&output=csv';

const WHATSAPP = process.env.WHATSAPP || '56944350559';

// ── Cache en memoria (5 minutos) ──────────────────
let cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

// ── Parser CSV simple ─────────────────────────────
function parsearCSV(texto) {
  const lineas = texto.split('\n').filter(l => l.trim());
  if (lineas.length < 2) return [];

  const headers = lineas[0].split(',').map(h => h.trim().replace(/^\ufeff/, '').toLowerCase());

  return lineas.slice(1).map(linea => {
    // Manejo básico de campos con comas dentro de comillas
    const campos = [];
    let dentro = false, campo = '';
    for (const c of linea) {
      if (c === '"') { dentro = !dentro; }
      else if (c === ',' && !dentro) { campos.push(campo.trim()); campo = ''; }
      else { campo += c; }
    }
    campos.push(campo.trim());

    const obj = {};
    headers.forEach((h, i) => { obj[h] = campos[i] || ''; });
    return obj;
  });
}

// ── Cargar productos desde Google Sheets ──────────
async function cargarProductos() {
  const ahora = Date.now();
  if (cache.data && (ahora - cache.ts) < CACHE_MS) {
    return cache.data;
  }

  const res  = await fetch(SHEETS_URL);
  const texto = await res.text();
  const filas = parsearCSV(texto);

  let id = 1;
  const productos = [];

  for (const f of filas) {
    const activo   = (f.activo  || '').toUpperCase().trim();
    const nombre   = (f.nombre  || '').trim();
    const precioRaw = (f.precio || '').replace(/[.$\s]/g, '').replace(',', '.');
    const precio   = parseFloat(precioRaw) || 0;

    // Solo activos con precio asignado
    if (activo !== 'SI') continue;
    if (!nombre)         continue;
    if (precio <= 0)     continue;

    const stockRaw = (f.stock || '').replace(/[.\s]/g, '').replace(',', '.');
    const stock    = parseInt(stockRaw) || 999;
    const cat      = (f.categoria || 'despensa').toLowerCase().trim();
    const img      = (f.imagen_url || '').trim();
    const barcode  = (f.barcode   || '').trim();
    const sku      = (f.sku       || '').trim();
    const tipo     = (f.tipo_bsale || '').toUpperCase().trim();
    const sub      = (f.subcategoria || '').trim();

    // Excluir filas internas/logísticas sin valor para clientes
    const TIPOS_EXCLUIDOS = ['AUTOMOVIL', 'SIN TIPO'];
    if (TIPOS_EXCLUIDOS.includes(tipo)) continue;

    productos.push({
      id:        id++,
      variantId: id,
      n:         nombre,
      p:         Math.round(precio),
      stock,
      img:       img || '',
      c:         cat,
      categoria: cat,
      tipo,
      sub,
      barCode:   barcode,
      code:      sku,
      oferta:    false,
    });
  }

  cache = { data: productos, ts: ahora };
  console.log(`📦 Google Sheets: ${productos.length} productos activos con precio`);
  return productos;
}

// ════════════════════════════════════════════════
//  RUTA 1 — GET /api/productos
// ════════════════════════════════════════════════
app.get('/api/productos', async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 50;
    const offset = parseInt(req.query.offset) || 0;
    const cat    = (req.query.categoria || '').toLowerCase();

    let todos = await cargarProductos();

    // Filtrar por categoría si se pide
    if (cat) todos = todos.filter(p => p.categoria === cat);

    const total    = todos.length;
    const pagina   = todos.slice(offset, offset + limit);

    res.json({ ok: true, total, limit, offset, productos: pagina });

  } catch (err) {
    console.error('❌ /api/productos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
//  RUTA 2 — GET /api/categorias
//  Lista todas las categorías con cantidad de productos
// ════════════════════════════════════════════════
app.get('/api/categorias', async (req, res) => {
  try {
    const todos = await cargarProductos();
    const mapa  = {};
    for (const p of todos) {
      mapa[p.categoria] = (mapa[p.categoria] || 0) + 1;
    }
    const categorias = Object.entries(mapa)
      .map(([nombre, cantidad]) => ({ nombre, cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad);

    res.json({ ok: true, categorias });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
//  RUTA 3 — GET /api/buscar?q=texto
// ════════════════════════════════════════════════
app.get('/api/buscar', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ ok: true, total: 0, productos: [] });

    const todos = await cargarProductos();
    const resultados = todos.filter(p =>
      p.n.toLowerCase().includes(q) ||
      p.barCode.includes(q)         ||
      p.code.includes(q)
    );

    res.json({ ok: true, total: resultados.length, productos: resultados.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
//  RUTA 4 — POST /api/pedido
//  Registra pedido (log en consola, WhatsApp en el front)
// ════════════════════════════════════════════════
app.post('/api/pedido', async (req, res) => {
  try {
    const { cliente, pago, items } = req.body;
    if (!cliente?.nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'Carrito vacío' });

    const total = items.reduce((s, it) => s + (it.precioUnitario * it.cantidad), 0);

    // Log del pedido
    console.log(`🛒 NUEVO PEDIDO — ${new Date().toISOString()}`);
    console.log(`   Cliente: ${cliente.nombre} | ${cliente.telefono}`);
    console.log(`   Dirección: ${cliente.direccion} — ${cliente.referencia}`);
    console.log(`   Pago: ${pago} | Total: $${total.toLocaleString('es-CL')}`);
    items.forEach(it => console.log(`   • ${it.cantidad}x ${it.nombre}`));

    res.json({ ok: true, message: 'Pedido registrado', total });

  } catch (err) {
    console.error('❌ /api/pedido:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
//  RUTA 5 — GET /api/reload
//  Fuerza recarga del caché desde Google Sheets
// ════════════════════════════════════════════════
app.get('/api/reload', async (req, res) => {
  try {
    cache = { data: null, ts: 0 }; // limpiar caché
    const productos = await cargarProductos();
    res.json({ ok: true, message: 'Caché recargado', total: productos.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════
//  RUTA PING
// ════════════════════════════════════════════════
app.get('/api/ping', (req, res) => {
  res.json({
    ok:      true,
    status:  'Servidor La Barata activo 🟢',
    version: '7.0.0 — Google Sheets',
    time:    new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor La Barata v7.0 — Google Sheets — puerto ${PORT}`);
  console.log(`   SHEETS_URL configurada: ${SHEETS_URL.substring(0, 60)}...`);
});
