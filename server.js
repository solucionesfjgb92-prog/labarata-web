// ══════════════════════════════════════════════════
//  SERVIDOR BACKEND — Distribuidora La Barata v7.0
//  Fuente de datos: Google Sheets (CSV público)
//  Sin Bsale — gestión simple desde planilla
// ══════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Flow envía sus webhooks como form-urlencoded
app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }));
app.use('/imagenes', express.static('IMAGENES PRODUCTOS'));

// ── URL del Google Sheets publicado como CSV ──────
const SHEETS_URL = process.env.SHEETS_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTxs_HEpIQwQ2GqbvBDHUwKAtvbz9YDliZE8JdPeOeBMUkLAnk6jW7unzIfkd8cGg/pub?gid=292915002&single=true&output=csv';

const WHATSAPP = process.env.WHATSAPP || '56944350559';

// ── FLOW (pagos con tarjeta) ──────────────────────
// Credenciales SIEMPRE por variables de entorno, nunca en el código.
// Sandbox por defecto: para producción setear FLOW_API_URL=https://www.flow.cl/api
const FLOW_API_KEY    = process.env.FLOW_API_KEY    || '';
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY || '';
const FLOW_API_URL    = process.env.FLOW_API_URL    || 'https://sandbox.flow.cl/api';
const DESPACHO_FIJO   = parseInt(process.env.DESPACHO_FIJO) || 3000;
const PUBLIC_URL      = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const FRONTEND_REDIRECT = process.env.FRONTEND_URL || 'https://www.distribuidoralabarata.cl';

// Pedidos pendientes de pago en memoria (respaldo adicional: campo "optional" en Flow).
// Nota: en Render free tier el proceso puede reiniciarse; el detalle compacto del
// pedido viaja también en "optional" para no perderlo.
const pedidosFlow    = new Map(); // commerceOrder -> pedido completo
const pagosLogueados = new Set(); // idempotencia entre webhook y retorno

// Firma Flow: params ordenados alfabéticamente, concatenados key+value sin
// separadores, HMAC-SHA256 hex con la secretKey. Se firman los valores SIN
// url-encodear (URLSearchParams codifica recién al enviar).
function firmarFlow(params) {
  const cadena = Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha256', FLOW_SECRET_KEY).update(cadena).digest('hex');
}

async function flowGetStatus(token) {
  const q = { apiKey: FLOW_API_KEY, token };
  q.s = firmarFlow(q);
  const r = await fetch(`${FLOW_API_URL}/payment/getStatus?${new URLSearchParams(q)}`);
  if (!r.ok) throw new Error(`Flow getStatus HTTP ${r.status}`);
  return r.json();
}

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
//  RUTA 6 — POST /api/pago/crear
//  Crea una orden de pago en Flow y devuelve la URL
//  de redirección. El total se calcula SIEMPRE en el
//  servidor con los precios del Google Sheets — los
//  precios enviados por el navegador se ignoran.
// ════════════════════════════════════════════════
app.post('/api/pago/crear', async (req, res) => {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Pagos con tarjeta no disponibles por ahora. Puedes pagar por transferencia.' });
    }

    const { cliente, items } = req.body;
    if (!cliente?.nombre?.trim() || !cliente?.direccion?.trim() || !cliente?.telefono?.trim()) {
      return res.status(400).json({ ok: false, error: 'Faltan datos del cliente' });
    }
    const email = (cliente.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido (Flow lo necesita para el comprobante)' });
    }
    if (!Array.isArray(items) || !items.length || items.length > 200) {
      return res.status(400).json({ ok: false, error: 'Carrito vacío o inválido' });
    }

    // Resolver cada ítem contra el catálogo del servidor (precio real)
    const catalogo = await cargarProductos();
    const porId = new Map(catalogo.map(p => [p.id, p]));
    const lineas = [];
    for (const it of items) {
      const cant = parseInt(it.cantidad);
      if (!cant || cant < 1 || cant > 999) {
        return res.status(400).json({ ok: false, error: 'Cantidad inválida en el carrito' });
      }
      // Los ids se asignan por orden de fila del Sheet: si la planilla cambió
      // entre que el cliente cargó la página y pagó, el id puede apuntar a otra
      // fila. Se verifica por nombre y se recurre a búsqueda exacta si no calza.
      let prod = porId.get(parseInt(it.id));
      if (!prod || (it.n && prod.n !== it.n)) {
        prod = it.n ? catalogo.find(p => p.n === it.n) : null;
      }
      if (!prod) {
        return res.status(409).json({ ok: false, error: 'El catálogo cambió mientras comprabas. Recarga la página e intenta de nuevo.' });
      }
      lineas.push({ id: prod.id, n: prod.n, p: prod.p, cantidad: cant });
    }

    const subtotal = lineas.reduce((s, l) => s + l.p * l.cantidad, 0);
    const total    = subtotal + DESPACHO_FIJO;
    if (total < 350) return res.status(400).json({ ok: false, error: 'El monto mínimo para pagar con tarjeta es $350' });

    const commerceOrder = `LB-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;

    // Respaldo compacto del pedido que viaja en Flow (sobrevive reinicios del server)
    const optional = JSON.stringify({
      nom:  cliente.nombre.trim().slice(0, 60),
      tel:  cliente.telefono.trim().slice(0, 20),
      dir:  `${cliente.direccion.trim()} / ${(cliente.referencia || '').trim()}`.slice(0, 120),
      det:  lineas.map(l => `${l.cantidad}x ${l.n}`).join(', ').slice(0, 400),
      sub:  subtotal,
      desp: DESPACHO_FIJO,
    });

    const params = {
      apiKey:          FLOW_API_KEY,
      commerceOrder,
      subject:         `Pedido La Barata ${commerceOrder}`,
      currency:        'CLP',
      amount:          total,
      email,
      paymentMethod:   9,
      urlConfirmation: `${PUBLIC_URL}/api/pago/confirmacion`,
      urlReturn:       `${PUBLIC_URL}/api/pago/retorno`,
      optional,
    };
    params.s = firmarFlow(params);

    const r = await fetch(`${FLOW_API_URL}/payment/create`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(params).toString(),
    });
    const data = await r.json();
    if (!r.ok || !data.url || !data.token) {
      console.error('❌ Flow payment/create:', r.status, JSON.stringify(data));
      return res.status(502).json({ ok: false, error: data.message || 'Flow no aceptó la orden de pago. Intenta de nuevo.' });
    }

    pedidosFlow.set(commerceOrder, {
      cliente: { nombre: cliente.nombre, telefono: cliente.telefono, direccion: cliente.direccion, referencia: cliente.referencia || '', email },
      lineas, subtotal, despacho: DESPACHO_FIJO, total,
      flowOrder: data.flowOrder, creado: new Date().toISOString(),
    });
    if (pedidosFlow.size > 500) pedidosFlow.delete(pedidosFlow.keys().next().value);

    console.log(`💳 Orden Flow creada: ${commerceOrder} (flowOrder ${data.flowOrder}) — $${total.toLocaleString('es-CL')} (${lineas.length} productos + despacho $${DESPACHO_FIJO.toLocaleString('es-CL')})`);
    res.json({ ok: true, redirect: `${data.url}?token=${data.token}`, commerceOrder, subtotal, despacho: DESPACHO_FIJO, total });

  } catch (err) {
    console.error('❌ /api/pago/crear:', err.message);
    res.status(500).json({ ok: false, error: 'Error interno creando el pago' });
  }
});

// ════════════════════════════════════════════════
//  RUTA 7 — POST /api/pago/confirmacion
//  Webhook servidor-a-servidor de Flow. Debe responder
//  200 rápido (<15s). El estado SIEMPRE se valida con
//  getStatus — nunca por la sola llegada del POST.
// ════════════════════════════════════════════════
app.post('/api/pago/confirmacion', async (req, res) => {
  const token = req.body?.token;
  if (!token) return res.sendStatus(400);
  try {
    const pago = await flowGetStatus(token);

    if (pago.status === 2 && !pagosLogueados.has(pago.commerceOrder)) {
      pagosLogueados.add(pago.commerceOrder);
      console.log(`✅ PAGO CONFIRMADO — ${pago.commerceOrder} (flowOrder ${pago.flowOrder}) — $${Number(pago.amount).toLocaleString('es-CL')} — ${new Date().toISOString()}`);

      const ped = pedidosFlow.get(pago.commerceOrder);
      if (ped) {
        console.log(`   Cliente: ${ped.cliente.nombre} | ${ped.cliente.telefono} | ${ped.cliente.email}`);
        console.log(`   Dirección: ${ped.cliente.direccion} — ${ped.cliente.referencia}`);
        ped.lineas.forEach(l => console.log(`   • ${l.cantidad}x ${l.n} — $${(l.p * l.cantidad).toLocaleString('es-CL')}`));
        console.log(`   Subtotal $${ped.subtotal.toLocaleString('es-CL')} + Despacho $${ped.despacho.toLocaleString('es-CL')}`);
      } else if (pago.optional) {
        // El server se reinició: recuperar el respaldo que viajó en Flow
        try {
          const o = typeof pago.optional === 'string' ? JSON.parse(pago.optional) : pago.optional;
          console.log(`   (recuperado de Flow) Cliente: ${o.nom} | ${o.tel}`);
          console.log(`   (recuperado de Flow) Dirección: ${o.dir}`);
          console.log(`   (recuperado de Flow) Detalle: ${o.det}`);
        } catch (e) { console.log('   ⚠️ optional no parseable:', pago.optional); }
      }
    } else if (pago.status === 3 || pago.status === 4) {
      console.log(`⚠️ Pago ${pago.status === 3 ? 'RECHAZADO' : 'ANULADO'} — ${pago.commerceOrder} (flowOrder ${pago.flowOrder})`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ /api/pago/confirmacion:', err.message);
    res.sendStatus(500);
  }
});

// ════════════════════════════════════════════════
//  RUTA 8 — /api/pago/retorno
//  Flow redirige aquí el navegador del cliente (POST
//  según doc vigente; GET defensivo por si acaso) y
//  nosotros lo devolvemos al sitio con el resultado.
// ════════════════════════════════════════════════
async function manejarRetornoFlow(req, res) {
  const token = req.body?.token || req.query?.token;
  let destino = `${FRONTEND_REDIRECT}/?pago=error`;
  if (token) {
    try {
      const pago  = await flowGetStatus(token);
      const orden = encodeURIComponent(pago.commerceOrder || '');
      if      (pago.status === 2) destino = `${FRONTEND_REDIRECT}/?pago=exitoso&orden=${orden}`;
      else if (pago.status === 1) destino = `${FRONTEND_REDIRECT}/?pago=pendiente&orden=${orden}`;
      else                        destino = `${FRONTEND_REDIRECT}/?pago=rechazado&orden=${orden}`;
    } catch (err) {
      console.error('❌ /api/pago/retorno:', err.message);
    }
  }
  res.redirect(302, destino);
}
app.post('/api/pago/retorno', manejarRetornoFlow);
app.get('/api/pago/retorno',  manejarRetornoFlow);

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

  // Auto-ping cada 14 min para evitar cold start en Render free tier
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    fetch(`${SELF_URL}/api/ping`)
      .then(() => console.log(`🏓 Self-ping OK — ${new Date().toISOString()}`))
      .catch(err => console.warn(`⚠️ Self-ping falló: ${err.message}`));
  }, 14 * 60 * 1000);
});
