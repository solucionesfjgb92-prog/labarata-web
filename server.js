// ══════════════════════════════════════════════════
//  SERVIDOR BACKEND — Distribuidora La Barata v7.0
//  Fuente de datos: Google Sheets (CSV público)
//  Sin Bsale — gestión simple desde planilla
// ══════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
// Solo se usa en la vía SMTP; con Brevo el envío va por HTTPS y no hace falta.
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}
const dns    = require('dns');
const net    = require('net');
require('dotenv').config();

// Render solo tiene salida IPv4. Node 18 devuelve las direcciones en el
// orden del DNS, que suele poner la IPv6 primero, y la conexión muere en
// ENETUNREACH sin llegar a probar la IPv4. Esto aplica a todo el proceso.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

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

// ── TRANSBANK WEBPAY PLUS (REST API v1.2) ─────────
// Pasarela activa: 'webpay' o 'flow'. El código de ambas convive;
// esta variable decide cuál usa el checkout.
const PASARELA = (process.env.PASARELA || 'webpay').toLowerCase();

// Credenciales de INTEGRACIÓN (públicas, publicadas por Transbank para
// pruebas). En producción se sobreescriben por variables de entorno.
const TBK_PROD  = process.env.TBK_ENV === 'production';
const TBK_HOST  = TBK_PROD ? 'https://webpay3g.transbank.cl'
                           : 'https://webpay3gint.transbank.cl';
const TBK_BASE  = `${TBK_HOST}/rswebpaytransaction/api/webpay/v1.2/transactions`;
const TBK_HEADERS = {
  'Tbk-Api-Key-Id':     process.env.TBK_COMMERCE_CODE  || '597055555532',
  'Tbk-Api-Key-Secret': process.env.TBK_API_KEY_SECRET ||
    '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C',
  'Content-Type': 'application/json',
};

const TBK_RESPONSE_CODE = {
  0: 'Aprobada', '-1': 'Rechazo de transacción', '-2': 'Debe reintentarse',
  '-3': 'Error en transacción', '-4': 'Rechazada por el emisor',
  '-5': 'Rechazo por error de tasa', '-6': 'Excede cupo máximo mensual',
  '-7': 'Excede límite diario por transacción', '-8': 'Rubro no autorizado',
};
const TBK_PAYMENT_TYPE = {
  VD: 'Débito', VN: 'Crédito sin cuotas', VC: 'Crédito en cuotas',
  SI: '3 cuotas sin interés', S2: '2 cuotas sin interés',
  NC: 'N cuotas sin interés', VP: 'Prepago',
};

// Pedidos Webpay en memoria (igual que Flow: en Render free tier el
// proceso puede reiniciarse, por eso también se loguea todo).
const pedidosWebpay = new Map(); // buyOrder -> pedido
const tokensWebpay  = new Map(); // token    -> buyOrder

async function tbk(method, path, body) {
  const r = await fetch(TBK_BASE + path, {
    method,
    headers: TBK_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: 20000,
  });
  const txt = await r.text();
  let data = {};
  if (txt) { try { data = JSON.parse(txt); } catch (_) { data = { raw: txt }; } }
  if (!r.ok) {
    const e = new Error(data.error_message || `Transbank HTTP ${r.status}`);
    e.status = r.status; e.body = data;
    throw e;
  }
  return data;
}
const tbkCrear  = (payload) => tbk('POST', '', payload);
const tbkCommit = (token)   => tbk('PUT',  `/${encodeURIComponent(token)}`);
const tbkStatus = (token)   => tbk('GET',  `/${encodeURIComponent(token)}`);
const tbkRefund = (token, monto) => tbk('POST', `/${encodeURIComponent(token)}/refunds`, { amount: Math.round(monto) });

function marcarWebpay(buyOrder, estado, resp) {
  const p = pedidosWebpay.get(buyOrder);
  if (!p) return;
  p.estado = estado;
  if (resp) p.respuesta = resp;
  p.actualizado = new Date().toISOString();
}

// ── CORREO DE CONFIRMACIÓN DE COMPRA ──────────────
// Requisito legal (art. 12 A Ley 19.496): si el comercio NO envía la
// confirmación escrita del contrato, el plazo de retracto del cliente se
// extiende de 10 a 90 días. Debe incluir el detalle del pedido, el costo
// de despacho, el total, los datos del proveedor y acceso a los términos.
// El plan gratuito de Render bloquea la salida a los puertos 25, 465 y 587
// (medido: timeout en los tres, 443 abierto en 12 ms), así que el SMTP
// directo es imposible ahí. La vía real es la API HTTPS de Brevo, que sale
// por el 443. El SMTP se conserva como camino alternativo: sirve en local y
// volvería a funcionar si algún día Render pasa a un plan de pago.
const BREVO_API_KEY  = process.env.BREVO_API_KEY || '';
// Configurable solo para poder apuntar a un servidor falso en las pruebas.
const BREVO_API_URL  = process.env.BREVO_API_URL || 'https://api.brevo.com/v3';
const CORREO_COMERCIO = process.env.CORREO_COMERCIO || 'distribuidoralabaratavaldivia@gmail.com';
// El dominio está autenticado en Brevo (SPF + DKIM + DMARC verificados el
// 2026-07-25), así que el correo sale desde el dominio propio: alinea DMARC,
// mejora la entrega y no muestra el remitente reescrito de Brevo. Las
// respuestas van igual al Gmail, porque el dominio no tiene MX.
const REMITENTE = process.env.CORREO_REMITENTE || 'pedidos@distribuidoralabarata.cl';

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465;

const VIA_BREVO = !!BREVO_API_KEY;
const VIA_SMTP  = !VIA_BREVO && !!(SMTP_USER && SMTP_PASS) && !!nodemailer;
const CORREO_ACTIVO = VIA_BREVO || VIA_SMTP;

let transporter = null;
if (VIA_SMTP) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Render no tiene salida IPv6 y Node 18 prueba primero la AAAA, así que
    // smtp.gmail.com moría en ENETUNREACH sin llegar a intentar la IPv4.
    family: 4,
    // Sin timeouts explícitos, un puerto SMTP bloqueado deja la conexión
    // colgada minutos antes de fallar y el error nunca aparece.
    connectionTimeout: 15000,
    greetingTimeout:   15000,
    socketTimeout:     20000,
  });
}

// Un solo punto de envío para los dos caminos. Devuelve una promesa que
// resuelve con un texto corto describiendo qué respondió el proveedor.
async function despacharCorreo({ para, nombre, asunto, html, texto }) {
  if (VIA_BREVO) {
    const r = await fetch(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender:      { name: 'Distribuidora La Barata', email: REMITENTE },
        to:          [{ email: para, name: nombre || para }],
        bcc:         [{ email: CORREO_COMERCIO }], // copia para el comercio
        // El dominio no tiene MX, así que si el remitente pasa a ser
        // pedidos@distribuidoralabarata.cl las respuestas rebotarían.
        // Se dirigen a la casilla que el comercio sí lee.
        replyTo:     { email: CORREO_COMERCIO, name: 'Distribuidora La Barata' },
        subject:     asunto,
        htmlContent: html,
        textContent: texto,
      }),
      timeout: 20000,
    });
    const cuerpo = await r.text();
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}: ${cuerpo.slice(0, 300)}`);
    return `Brevo ${r.status}: ${cuerpo.slice(0, 200)}`;
  }

  const info = await transporter.sendMail({
    from: `"Distribuidora La Barata" <${SMTP_USER}>`,
    to: para, bcc: SMTP_USER, subject: asunto, text: texto, html,
  });
  return `SMTP: ${info.response}`;
}

// El envío es fire-and-forget para no frenar la venta, así que el error
// se guarda acá: es la única forma de ver qué pasó sin leer los logs.
let ultimoCorreo = null;
function registrarCorreo(datos) {
  ultimoCorreo = { ...datos, fecha: new Date().toISOString() };
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const clp = (n) => '$' + Number(n || 0).toLocaleString('es-CL');

// Mismo criterio que el frontend: solo perecibles reales quedan excluidos
// del derecho a retracto, y hay que informarlo en la confirmación.
const CATS_PERECIBLES  = ['congelados', 'carnes'];
const PALABRAS_FRIO    = ['CREMA', 'QUESO', 'QUESILLO', 'YOGH', 'YOGURT', 'MANTEQUILLA', 'MARGARINA', 'HELADO'];
function esPerecible(linea) {
  const cat = (linea.c || linea.categoria || '').toLowerCase();
  if (CATS_PERECIBLES.includes(cat)) return true;
  if (cat === 'lacteos') {
    const n = (linea.n || '').toUpperCase();
    return PALABRAS_FRIO.some(k => n.includes(k));
  }
  return false;
}

function armarCorreo(ped, pago) {
  const esRetiro = ped.entrega === 'retiro';
  const filas = ped.lineas.map(l => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#374151;">
        ${escHtml(l.n)}${esPerecible(l) ? '<br><span style="font-size:11px;color:#b45309;">⚠️ Sin derecho a retracto (producto perecible)</span>' : ''}
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#6b7280;text-align:center;white-space:nowrap;">${l.cantidad} × ${clp(l.p)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#111827;text-align:right;font-weight:700;white-space:nowrap;">${clp(l.p * l.cantidad)}</td>
    </tr>`).join('');

  const hayPerecibles = ped.lineas.some(esPerecible);

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#16a34a;color:#fff;padding:20px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:20px;">✅ ¡Gracias por tu compra!</h1>
      <p style="margin:6px 0 0;font-size:14px;opacity:.9;">Distribuidora La Barata · Valdivia</p>
    </div>
    <div style="background:#fff;padding:20px;border:1px solid #e5e7eb;border-top:0;">
      <p style="font-size:15px;color:#374151;margin:0 0 16px;">Hola <strong>${escHtml(ped.cliente.nombre)}</strong>, recibimos tu pedido. Este correo es tu confirmación de compra — guárdalo.</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <tr><td style="font-size:13px;color:#6b7280;padding:4px 0;">N° de pedido</td><td style="font-size:13px;color:#111827;text-align:right;font-weight:700;">${escHtml(ped.buyOrder || ped.orden || '—')}</td></tr>
        <tr><td style="font-size:13px;color:#6b7280;padding:4px 0;">Fecha</td><td style="font-size:13px;color:#111827;text-align:right;">${new Date().toLocaleString('es-CL')}</td></tr>
        ${pago ? `<tr><td style="font-size:13px;color:#6b7280;padding:4px 0;">Forma de pago</td><td style="font-size:13px;color:#111827;text-align:right;">${escHtml(pago.medio)}${pago.autorizacion ? ` · Autorización ${escHtml(pago.autorizacion)}` : ''}</td></tr>` : ''}
      </table>

      <h2 style="font-size:15px;color:#111827;margin:18px 0 6px;">Tu pedido</h2>
      <table style="width:100%;border-collapse:collapse;">${filas}</table>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        <tr><td style="font-size:14px;color:#6b7280;padding:3px 0;">Subtotal productos</td><td style="font-size:14px;text-align:right;color:#111827;">${clp(ped.subtotal)}</td></tr>
        <tr><td style="font-size:14px;color:#6b7280;padding:3px 0;">${esRetiro ? 'Retiro en local' : 'Despacho a domicilio' + (ped.km ? ` (${ped.km} km)` : '')}</td><td style="font-size:14px;text-align:right;color:#111827;">${ped.despacho === 0 ? 'Gratis' : clp(ped.despacho)}</td></tr>
        <tr><td style="font-size:17px;font-weight:800;color:#111827;padding:8px 0;border-top:2px solid #16a34a;">TOTAL</td><td style="font-size:17px;font-weight:800;color:#16a34a;text-align:right;border-top:2px solid #16a34a;">${clp(ped.total)}</td></tr>
      </table>

      <h2 style="font-size:15px;color:#111827;margin:18px 0 6px;">${esRetiro ? 'Retiro' : 'Entrega'}</h2>
      <p style="font-size:14px;color:#374151;margin:0 0 4px;">
        ${esRetiro
          ? '🏬 Retiras en <strong>Av. Ramón Picarte 779, Valdivia</strong>.'
          : `📍 ${escHtml(ped.cliente.direccion)}${ped.cliente.referencia ? ' — ' + escHtml(ped.cliente.referencia) : ''}`}
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 4px;">📞 ${escHtml(ped.cliente.telefono)}</p>
      <p style="font-size:13px;color:#6b7280;margin:0;">
        ${esRetiro
          ? 'Te llamaremos para coordinar el horario de retiro. Atención: Lun–Vie 08:30–19:00 · Sáb y feriados 09:00–17:00.'
          : 'La fecha de entrega se coordina previamente por teléfono. Si no te encontramos en el domicilio, el pedido queda disponible para retiro en nuestra tienda. Despachos Lun–Vie 08:30–19:00 · Sáb y feriados 09:00–17:00.'}
      </p>

      ${hayPerecibles ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px;margin:16px 0;">
        <p style="margin:0;font-size:13px;color:#78350f;"><strong>⚠️ Sobre el derecho a retracto:</strong> tu pedido incluye productos perecibles o que requieren frío, que están excluidos del derecho a retracto (Decreto 52/2024). <strong>Esto no afecta tu garantía legal:</strong> si algo llega vencido o en mal estado, tienes derecho a cambio o a la devolución de tu dinero.</p>
      </div>` : ''}

      <div style="background:#f8fafc;border-radius:8px;padding:14px;margin:16px 0;">
        <p style="margin:0 0 8px;font-size:13px;color:#374151;"><strong>Tus derechos como consumidor</strong></p>
        <p style="margin:0 0 6px;font-size:12px;color:#6b7280;">Tienes <strong>derecho a retracto</strong> dentro de 10 días desde que recibes el producto (salvo perecibles) y <strong>garantía legal</strong> si algo llega malo, vencido o equivocado, pudiendo elegir entre cambio, devolución del dinero o reparación.</p>
        <p style="margin:0;font-size:12px;color:#6b7280;">Revisa las condiciones completas en <a href="${FRONTEND_REDIRECT}" style="color:#16a34a;">nuestro sitio</a>, sección <em>Cambios, devoluciones y reembolsos</em> y <em>Términos y condiciones</em>.</p>
      </div>

      <div style="border-top:1px solid #e5e7eb;padding-top:14px;margin-top:16px;">
        <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6;">
          <strong style="color:#374151;">Distribuidora La Barata</strong><br>
          SOCIEDAD COMERCIAL FAF SPA · RUT 77.557.632-4<br>
          Av. Ramón Picarte 779, Valdivia, Región de Los Ríos<br>
          distribuidoralabaratavaldivia@gmail.com · WhatsApp +56 9 4435 0559
        </p>
      </div>
    </div>
  </div></body></html>`;

  const texto = [
    `¡Gracias por tu compra en Distribuidora La Barata!`,
    ``,
    `Pedido: ${ped.buyOrder || ped.orden || '—'}`,
    `Fecha: ${new Date().toLocaleString('es-CL')}`,
    ...(pago ? [`Pago: ${pago.medio}${pago.autorizacion ? ' · Autorización ' + pago.autorizacion : ''}`] : []),
    ``,
    ...ped.lineas.map(l => `  ${l.cantidad} x ${l.n} — ${clp(l.p * l.cantidad)}`),
    ``,
    `Subtotal: ${clp(ped.subtotal)}`,
    `${esRetiro ? 'Retiro en local' : 'Despacho'}: ${ped.despacho === 0 ? 'Gratis' : clp(ped.despacho)}`,
    `TOTAL: ${clp(ped.total)}`,
    ``,
    esRetiro ? 'Retiro en Av. Ramón Picarte 779, Valdivia.' : `Entrega en: ${ped.cliente.direccion}`,
    ``,
    `Tienes derecho a retracto (10 días, salvo perecibles) y garantía legal.`,
    `Condiciones completas en ${FRONTEND_REDIRECT}`,
    ``,
    `SOCIEDAD COMERCIAL FAF SPA · RUT 77.557.632-4`,
    `Av. Ramón Picarte 779, Valdivia · +56 9 4435 0559`,
  ].join('\n');

  return { html, texto };
}

// ════════════════════════════════════════════════
//  REGISTRO DE PEDIDOS EN PLANILLA
// ════════════════════════════════════════════════
// El comercio quiere el pedido en una planilla además del correo, para tener
// historial. Se hace contra un Web App de Google Apps Script (doPost que
// agrega una fila), no con la API de Sheets: así no hay que meter credenciales
// de servicio en Render, igual que el catálogo, que ya se lee por URL
// publicada. Además sale por HTTPS/443, que es lo único que el plan gratuito
// de Render deja salir (los puertos de correo están bloqueados).
//
// PEDIDOS_SHEET_URL  = la URL /exec del Web App
// PEDIDOS_SHEET_TOKEN = clave compartida; el script rechaza lo que no la traiga
// Si no están configuradas, no se registra nada y la venta sigue igual.
const PEDIDOS_SHEET_URL   = process.env.PEDIDOS_SHEET_URL   || '';
const PEDIDOS_SHEET_TOKEN = process.env.PEDIDOS_SHEET_TOKEN || '';
let ultimoRegistroPlanilla = null;

// Nunca revienta hacia afuera: si la planilla falla, el cliente ya compró y el
// correo ya salió. Se deja constancia en el log y en /api/diagnostico/pedidos.
async function anotarEnPlanilla(ped, pago) {
  const orden = ped.buyOrder || ped.orden || '';
  if (!PEDIDOS_SHEET_URL) {
    ultimoRegistroPlanilla = { ok: false, orden, error: 'falta PEDIDOS_SHEET_URL', ts: new Date().toISOString() };
    return;
  }
  const lineas = Array.isArray(ped.lineas) ? ped.lineas : [];
  const fila = {
    token:      PEDIDOS_SHEET_TOKEN,
    fecha:      new Date().toISOString(),
    orden,
    medio:      pago?.medio || '',
    entrega:    ped.entrega === 'retiro' ? 'Retiro en local' : 'Despacho a domicilio',
    nombre:     ped.cliente?.nombre    || '',
    telefono:   ped.cliente?.telefono  || '',
    email:      ped.cliente?.email     || '',
    direccion:  ped.cliente?.direccion || '',
    referencia: ped.cliente?.referencia|| '',
    km:         ped.km ?? '',
    subtotal:   ped.subtotal ?? '',
    despacho:   ped.despacho ?? '',
    total:      ped.total ?? '',
    unidades:   lineas.reduce((s, l) => s + (Number(l.cantidad) || 0), 0),
    // Una sola celda con el detalle: la planilla es para leer el pedido de un
    // vistazo, no para analizarlo línea por línea.
    detalle:    lineas.map(l => `${l.cantidad}x ${l.n} ($${l.p})`).join(' | '),
  };

  try {
    const r = await fetch(PEDIDOS_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fila),
      signal: AbortSignal.timeout(10000),
    });
    const texto = (await r.text()).slice(0, 200);
    const ok = r.ok && !/error/i.test(texto);
    ultimoRegistroPlanilla = { ok, orden, status: r.status, respuesta: texto, ts: new Date().toISOString() };
    if (ok) console.log(`📄 Pedido ${orden} anotado en la planilla de registro`);
    else    console.warn(`⚠️ La planilla de pedidos respondió ${r.status}: ${texto}`);
  } catch (err) {
    ultimoRegistroPlanilla = { ok: false, orden, error: err.message, ts: new Date().toISOString() };
    console.warn(`⚠️ No se pudo anotar el pedido ${orden} en la planilla: ${err.message}`);
  }
}

// Embudo único de todo pedido confirmado — tarjeta (Flow o Webpay),
// transferencia y efectivo pasan por acá. Deja el registro para el comercio y
// manda el comprobante al cliente. El registro va primero y no depende del
// correo: si el cliente no dejó email, el pedido igual tiene que quedar
// anotado.
function registrarPedido(ped, pago) {
  anotarEnPlanilla(ped, pago);
  enviarConfirmacion(ped, pago);
}

// No bloquea la respuesta al cliente: si el correo falla, la venta sigue.
function enviarConfirmacion(ped, pago) {
  const destino = (ped.cliente?.email || '').trim();
  if (!destino) return;
  const orden = ped.buyOrder || ped.orden;
  if (!CORREO_ACTIVO) {
    console.warn(`⚠️ Correo de confirmación NO enviado (sin BREVO_API_KEY ni SMTP) — pedido ${orden}`);
    registrarCorreo({ ok: false, destino, orden, error: 'proveedor de correo sin configurar' });
    return;
  }
  const { html, texto } = armarCorreo(ped, pago);
  despacharCorreo({
    para: destino,
    nombre: ped.cliente?.nombre,
    asunto: `Confirmación de tu pedido ${orden || ''} — La Barata`,
    html, texto,
  })
  .then(respuesta => {
    console.log(`📧 Confirmación enviada a ${destino} — pedido ${orden}`);
    registrarCorreo({ ok: true, destino, orden, via: VIA_BREVO ? 'brevo' : 'smtp', respuesta });
  })
  .catch(err => {
    console.error(`❌ No se pudo enviar la confirmación a ${destino}:`, err.message);
    registrarCorreo({ ok: false, destino, orden, via: VIA_BREVO ? 'brevo' : 'smtp',
                      error: err.message, codigo: err.code, comando: err.command, respuestaSmtp: err.response });
  });
}

// ── DESPACHO POR DISTANCIA (tramos por km) ────────
// Origen: local de Av. Ramón Picarte 779, Valdivia.
// Tramos "kmMax:precio" separados por coma; el último kmMax es el radio
// máximo de despacho con tarjeta. DESPACHO_FIJO queda como tarifa de
// respaldo cuando la dirección no se puede geolocalizar.
const ORIGEN_LAT = parseFloat(process.env.ORIGEN_LAT) || -39.8196;
const ORIGEN_LON = parseFloat(process.env.ORIGEN_LON) || -73.2452;
const DESPACHO_TRAMOS = (process.env.DESPACHO_TRAMOS || '3:2000,6:3000,10:4500')
  .split(',')
  .map(t => { const [km, p] = t.split(':'); return { km: parseFloat(km), precio: parseInt(p) }; })
  .filter(t => t.km > 0 && t.precio > 0)
  .sort((a, b) => a.km - b.km);
const KM_MAX      = DESPACHO_TRAMOS[DESPACHO_TRAMOS.length - 1].km;
const FACTOR_RUTA = 1.3; // línea recta → aproximación de ruta en auto

const geoCache = new Map(); // dirección normalizada -> {lat,lon} | null

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Geocodifica con Nominatim (OpenStreetMap): gratis, sin API key.
// Su política pide identificarse con User-Agent y max ~1 req/s — el
// caché en memoria mantiene el uso muy por debajo de ese límite.
async function geocodificar(direccion) {
  const limpia = direccion.trim().toLowerCase().replace(/\s+/g, ' ');
  if (geoCache.has(limpia)) return geoCache.get(limpia);
  const q = /valdivia/i.test(direccion)
    ? `${direccion}, Chile`
    : `${direccion}, Valdivia, Región de Los Ríos, Chile`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cl&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'LaBarata-Valdivia/1.0 (distribuidoralabaratavaldivia@gmail.com)' },
    timeout: 8000,
  });
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  const data = await r.json();
  const hit = Array.isArray(data) && data[0]
    ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
    : null;
  geoCache.set(limpia, hit);
  if (geoCache.size > 1000) geoCache.delete(geoCache.keys().next().value);
  return hit;
}

// { ok:true, metodo:'distancia'|'fijo', km, costo } o { ok:false, fueraDeCobertura:true, km }
async function calcularDespacho(direccion) {
  try {
    const punto = await geocodificar(direccion);
    if (!punto) return { ok: true, metodo: 'fijo', km: null, costo: DESPACHO_FIJO };
    const km = Math.round(haversineKm(ORIGEN_LAT, ORIGEN_LON, punto.lat, punto.lon) * FACTOR_RUTA * 10) / 10;
    if (km > 60) return { ok: true, metodo: 'fijo', km: null, costo: DESPACHO_FIJO }; // geocodificación claramente errada
    if (km > KM_MAX) return { ok: false, fueraDeCobertura: true, km };
    const tramo = DESPACHO_TRAMOS.find(t => km <= t.km);
    return { ok: true, metodo: 'distancia', km, costo: tramo.precio };
  } catch (err) {
    console.warn('⚠️ Geocodificación falló:', err.message);
    return { ok: true, metodo: 'fijo', km: null, costo: DESPACHO_FIJO };
  }
}

// ── Cache en memoria (5 minutos) ──────────────────
let cache = { data: null, ts: 0 };
// Productos retenidos por precio fuera de rango. Se guardan para poder
// consultarlos desde /api/diagnostico/catalogo sin entrar a los logs.
let ultimosSospechosos = [];
// Mismo criterio que los sospechosos: lo que se descarta se puede consultar
// desde /api/diagnostico/catalogo sin entrar a los logs de Render.
let ultimosNormalesInvalidos = [];
let ultimasOfertasVencidas = [];
let ultimosPreciosIncoherentes = { avisos: [], omitidosSinStock: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

// ── Parser CSV simple ─────────────────────────────
// Productos que no se venden por la web, por decisión del comercio.
// La línea automotriz y los sacos de alimento de mascota se entregan sólo en
// el local por volumen; los Huggies salieron a pedido del comercio.
// Ojo con "CAVA": es una marca que hace tanto productos de auto como de aseo
// doméstico, así que se nombra producto por producto en vez de excluir la
// marca entera — el limpiavidrios, el lustramuebles y la pasta desmanchadora
// SÍ se venden.
// Lo correcto a futuro es marcar estas filas como activo=NO en la planilla y
// borrar esta lista: dos interruptores para lo mismo terminan confundiendo.
const EXCLUIDOS_WEB = [
  /NATIMAX/i,
  /HUGGIES/i,
  /\bCAVA\b/i,
  /SOPROLE/i,
  /BONANZA/i,
  /BAKELS/i,
  // Los sacos se despachan solo en el local por peso y volumen.
  /\bSACOS?\b/i,
  // Alimento de mascota, completo. Va por NOMBRE y no por la subcategoría de
  // la planilla, que está descuadrada: ahí las mascarillas, la mermelada, el
  // atún y una sombra de ojos figuran como "Alimento Perro" o "Alimento Gato",
  // mientras que el alimento de gato real figura en "Embutidos y Fiambres".
  // "PEDEGREE" está mal escrito en la planilla, por eso la E opcional.
  /MASTER ?CAT|MASTERDOG|EKOSCAN|EKOSCAT|TRIGONO|PED[EI]GREE|WHISKAS|CAT ?CHOW|RAZA GATO/i,
];

// Packs de reventa: cajas y formatos mayoristas que no se venden por la web.
// Se nombran uno por uno a propósito — la palabra "PACK" sola se lleva 50
// productos, entre ellos los multipacks normales de leche, yoghurt, pañales y
// pasta de dientes, que son de los que mejor se venden por internet.
const PACKS_MAYORISTAS = [
  'PACK COMPOTA PF X3',
  'PACK KETCHUP EL AS 800GR X 3',
  'PACK MOSTAZA EL AS 800GR X 3',
  'PACK MAYONESA EL AS 800GR X 3',
  'PACK TOALLITAS ANTIBACTERIAL X10paquetes',
  'PACK X10 CUADERNO ESPIRAL 100HOJAS',
  'PACK X10 CUADERNO LISO 80 HOJAS',
  'PACK FULLMINT MENTA 336GR 12UNID',
  'PACK FULLMINT MIEL 336GR 12UNID',
  'PACK OMO MATIC 2.7 X3',
  'SABANILLA HIGIENICLIN 90X60 PACK X3 10unidades',
  'SABANILLA HIGIENICLIN 90X60 PACK X3 6unidades',
].map(n => n.toUpperCase());
// Excepciones, en el orden en que importan:
//  · CAVA es una marca que hace productos de auto y de aseo del hogar; estos
//    tres son de casa y sí se venden.
//  · Las harinas quedan fuera de la regla de los sacos por decisión del
//    comercio. Hoy ninguna se llama "saco", pero si mañana se agrega una,
//    esta excepción evita que desaparezca sin que nadie se dé cuenta.
const EXCEPCIONES_WEB = /LIMPIA ?VIDRIO|LUSTRA ?MUEBLE|DESMANCHADORA|HARINA/i;

function excluidoDeLaWeb(nombre) {
  if (PACKS_MAYORISTAS.includes(nombre.trim().toUpperCase())) return true;
  if (EXCEPCIONES_WEB.test(nombre)) return false;
  return EXCLUIDOS_WEB.some(re => re.test(nombre));
}

// Red de seguridad contra precios mal tipeados en la planilla. Han aparecido
// filas con el código pegado en la columna de precio: un turrón de 80 g a
// $863.302 y un shampoo a $2.014.371, además de una línea interna de
// logística colada como producto a $287.767. El artículo legítimo más caro
// del catálogo es un saco de papas de 25 kg a $87.500, así que el tope deja
// un margen amplio y sólo ataja errores evidentes.
// No se descarta en silencio: cada uno se nombra en el log al cargar.
const PRECIO_MAXIMO = parseInt(process.env.PRECIO_MAXIMO) || 150000;

// Solo se publica lo que tiene un número de stock asignado en la planilla.
// Decisión del comercio: así arma el catálogo de a poco, revisando nombre,
// categoría y precio de cada producto antes de que salga a la venta — con la
// planilla en el estado en que está, es más seguro publicar de a uno que
// publicar todo y corregir después.
// Para volver al modo anterior (celda vacía = se vende igual):
// STOCK_OBLIGATORIO=false en Render.
const STOCK_OBLIGATORIO = process.env.STOCK_OBLIGATORIO !== 'false';

// La planilla se llena a mano y Google exporta la fecha con el formato de la
// hoja, así que se aceptan las tres formas que van a aparecer en la práctica:
// 2026-08-03, 03-08-2026 y 03/08/2026 (con o sin cero adelante, año de 2 o 4
// dígitos). Cualquier otra cosa devuelve null y la oferta simplemente queda sin
// fecha de término, que es el lado seguro: mejor una oferta sin vencimiento que
// una apagada por no entender lo que el comercio escribió.
// Devuelve 'YYYY-MM-DD' o null.
function parsearFecha(valor) {
  const t = (valor || '').trim();
  if (!t) return null;

  let a, m, d;
  let mt = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (mt) { [, a, m, d] = mt; }
  else {
    mt = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
    if (!mt) return null;
    [, d, m, a] = mt;
    if (a.length === 2) a = '20' + a;   // 03/08/26 → 2026
  }

  a = +a; m = +m; d = +d;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Rechaza fechas que no existen (31/02) sin depender de que Date las corrija
  const prueba = new Date(Date.UTC(a, m - 1, d));
  if (prueba.getUTCMonth() !== m - 1 || prueba.getUTCDate() !== d) return null;

  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// La oferta vale hasta el final del día indicado, hora de Chile. Render corre
// en UTC y Chile está en UTC-4 (UTC-3 en horario de verano), así que se suman
// 27 horas al 00:00 UTC de ese día: en verano corta justo a medianoche local y
// en invierno una hora antes. Se eligió cortar un poco antes en vez de un poco
// después: seguir anunciando un descuento ya vencido es el error que no
// conviene cometer.
function finDelDiaChile(fechaISO) {
  return Date.parse(fechaISO + 'T00:00:00Z') + 27 * 3600 * 1000;
}

// ════════════════════════════════════════════════
//  AUDITORÍA DE PRECIOS POR FORMATO
// ════════════════════════════════════════════════
// Red de seguridad para el error que el tope de PRECIO_MAXIMO no ve: dos celdas
// de precio pegadas al revés. Pasó con la mantequilla Alerce (125 g a $2.000 y
// 250 g a $1.390, o sea $16.000 el kilo contra $5.560) y con toda la línea de
// yoghurt (los de 125 g entre $790 y $2.000, los de litro a $200).
//
// Compara el precio por kilo o litro entre los formatos de un mismo producto.
// SOLO AVISA, no esconde nada: el formato se lee del nombre, que es texto
// escrito a mano, así que un falso positivo es perfectamente posible y ocultar
// un producto vendible por eso sería peor que el problema que se quiere evitar.
//
// Mira también las filas que todavía no están publicadas, que es donde
// conviene encontrar el error: antes de cargarles stock.

// Lee el formato del nombre: "1LT", "125GR", "3KG", "900ML", "X6".
// Devuelve null si no se entiende, y entonces esa fila no se audita.
function formatoDe(nombre) {
  const n = nombre.toUpperCase();
  let cant = null, token = null;
  const intentos = [
    [/(\d+(?:[.,]\d+)?)\s*(?:LTS|LTR|LT|L)(?![A-Z])/, 1],
    [/(\d+(?:[.,]\d+)?)\s*(?:KGS|KG|K)(?![A-Z])/,      1],
    [/(\d+(?:[.,]\d+)?)\s*(?:GRS|GR|G)(?![A-Z])/,      0.001],
    [/(\d+(?:[.,]\d+)?)\s*(?:ML|CC)(?![A-Z])/,         0.001],
  ];
  for (const [re, factor] of intentos) {
    const m = n.match(re);
    if (m) { cant = parseFloat(m[1].replace(',', '.')) * factor; token = m[0]; break; }
  }
  if (!cant || cant <= 0) return null;

  const pack = n.match(/X\s?(\d+)/);
  const unidades = pack ? parseInt(pack[1], 10) : 1;

  // La familia es el nombre sin el formato ni el pack: así "MANTEQUILLA ALERCE
  // 125 GRS" y "MANTEQUILLA ALERCE 250 GRS" caen en el mismo grupo.
  let familia = n.replace(token, ' ');
  if (pack) familia = familia.replace(pack[0], ' ');
  familia = familia.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (familia.length < 6) return null;   // nombre demasiado pobre para agrupar

  return { total: cant * unidades, familia };
}

function auditarPreciosPorFormato(filas) {
  const familias = new Map();
  for (const f of filas) {
    const fm = formatoDe(f.nombre);
    if (!fm) continue;
    if (!familias.has(fm.familia)) familias.set(fm.familia, []);
    familias.get(fm.familia).push({
      n: f.nombre, precio: f.precio, total: fm.total, unitario: f.precio / fm.total,
      enVenta: !!f.enVenta,
    });
  }

  const avisos = [];
  const dormidos = [];   // avisos de filas sin stock: se cuentan, no se listan
  const $ = v => '$' + Math.round(v).toLocaleString('es-CL');

  for (const [, items] of familias) {
    if (items.length < 2) continue;

    // Señal más fuerte: el envase grande cuesta MENOS en pesos que el chico.
    // Eso casi nunca es un precio real, es un par de celdas invertidas.
    for (const a of items) {
      for (const b of items) {
        if (a.total > b.total && a.precio < b.precio) {
          const dest = (a.enVenta ? avisos : dormidos);
          if (!a.enVenta && !b.enVenta) { dormidos.push(1); continue; }
          dest.push(`PROBABLEMENTE INVERTIDOS: "${a.n}" (${$(a.precio)})${a.enVenta ? ' [EN VENTA]' : ''} es más grande y más barato que "${b.n}" (${$(b.precio)})${b.enVenta ? ' [EN VENTA]' : ''}`);
        }
      }
    }

    // Señal más suave: mucha diferencia en el precio por kilo o litro.
    const orden = [...items].sort((x, y) => x.unitario - y.unitario);
    const bajo = orden[0], alto = orden[orden.length - 1];
    const razon = alto.unitario / bajo.unitario;
    if (razon >= 2.5) {
      if (!alto.enVenta && !bajo.enVenta) { dormidos.push(1); }
      else avisos.push(`REVISAR: "${alto.n}" a ${$(alto.unitario)} por kg/L${alto.enVenta ? ' [EN VENTA]' : ''} contra "${bajo.n}" a ${$(bajo.unitario)}${bajo.enVenta ? ' [EN VENTA]' : ''} — ${razon.toFixed(1)} veces de diferencia`);
    }
  }
  // Se listan solo los que tocan a un producto a la venta: el comercio corrige
  // el precio cuando le carga stock, así que avisar del resto es ruido. Los
  // omitidos se cuentan para no esconderlos del todo.
  return { avisos, omitidosSinStock: dormidos.length };
}

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
  let excluidos = 0;
  let sinStock   = 0;
  const sospechosos = [];
  const normalesInvalidos = [];   // precio_normal que no es mayor que el de venta
  const vencidas = [];            // ofertas apagadas por vigencia_hasta
  // Para la auditoría de precios por formato: se juntan también las filas que
  // todavía no se publican, porque ahí es donde conviene pillar el error.
  const paraAuditoria = [];
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

    // Stock, tres estados y ninguno ambiguo:
    //   · celda vacía → null, sin control: se vende sin tope
    //   · 0           → agotado
    //   · número      → tope de venta por la web
    // Antes la celda vacía se convertía en 999, que era indistinguible de un
    // stock real de 999 y hacía que el sitio mostrara "999 disp." en todos
    // los productos.
    const stockRaw = (f.stock || '').replace(/[.\s]/g, '').replace(',', '.');
    const stockNum = parseInt(stockRaw, 10);
    const stock    = Number.isFinite(stockNum) ? stockNum : null;

    // Se audita el precio de TODA fila activa con precio, publicada o no, y se
    // anota si está en venta: un precio invertido en un producto ya publicado
    // es urgente, en uno sin stock se puede corregir con calma.
    paraAuditoria.push({ nombre, precio, enVenta: stock > 0 });

    // Con STOCK_OBLIGATORIO=true solo se publica lo que tiene un número mayor
    // que cero. Sirve para ir armando el catálogo de a poco, revisando nombre,
    // categoría y precio de cada producto antes de que salga a la venta.
    // OJO: al encenderlo la tienda queda vacía hasta que se carguen números.
    if (STOCK_OBLIGATORIO && !(stock > 0)) { sinStock++; continue; }
    if (stock === 0) { sinStock++; continue; }
    const cat      = (f.categoria || 'despensa').toLowerCase().trim();
    const img      = (f.imagen_url || '').trim();
    const barcode  = (f.barcode   || '').trim();
    const sku      = (f.sku       || '').trim();
    const tipo     = (f.tipo_bsale || '').toUpperCase().trim();
    const sub      = (f.subcategoria || '').trim();

    // Columna "descripcion" (N). Texto libre que se muestra en la ficha del
    // producto. Se recorta a 800 caracteres: una celda con un texto enorme
    // pegado desde otra parte no puede reventar el diseño de la ficha, y 800
    // alcanza de sobra para describir un producto de almacén.
    // Si la columna no existe todavía, queda vacía y la ficha simplemente no
    // muestra el bloque de descripción.
    const descripcion = (f.descripcion || '').trim().slice(0, 800);

    // Columna "oferta" (K en la planilla). Marca qué productos salen
    // destacados en el home, en la lámina de ofertas del carrusel y en la
    // categoría "Ofertas" del menú. Antes esto viajaba fijo en false, así que
    // la sección de ofertas del sitio nunca tuvo nada y quedaba escondida.
    //
    // No hay columna de precio anterior, así que el sitio no muestra ningún
    // precio tachado: la oferta se anuncia con el precio real de la planilla y
    // es el mismo que cobra el carrito. Si algún día se agrega
    // "precio_normal", ahí sí se puede mostrar el descuento.
    //
    // Se acepta SI, SÍ, S, X, TRUE y 1 porque la planilla se llena a mano y ya
    // pasó con "activo" que aparecieran variantes. Si la columna no existe
    // todavía, esto queda en false y el sitio funciona igual que antes.
    let oferta = ['SI', 'SÍ', 'S', 'X', 'TRUE', '1']
      .includes((f.oferta || '').toUpperCase().trim());

    // Columnas "precio_normal" (L) y "vigencia_hasta" (M).
    //
    // precio_normal es el precio de antes, el que se muestra tachado junto al
    // ahorro. Sólo se acepta si es MAYOR que el precio de venta: si viene igual
    // o menor no hay descuento que mostrar y un tachado ahí sería un cartel
    // falso. Los rechazados se nombran en /api/diagnostico/catalogo en vez de
    // descartarse en silencio, igual que los precios fuera de rango.
    //
    // vigencia_hasta apaga la oferta sola cuando pasa la fecha. Es lo que evita
    // el problema clásico de dejar publicada una oferta de la semana pasada.
    // OJO: al vencer se cae SOLO la oferta (el badge, el tachado y la sección
    // de ofertas). El precio NO cambia: el que manda sigue siendo la columna
    // "precio" de la planilla, así que si la promoción terminó hay que subir
    // el precio a mano.
    let precioNormal = 0;
    let vigenciaHasta = null;
    let ofertaVencida = false;

    if (oferta) {
      const pnRaw = (f.precio_normal || '').replace(/[.$\s]/g, '').replace(',', '.');
      const pn = parseFloat(pnRaw) || 0;
      if (pn > 0 && pn <= precio) {
        normalesInvalidos.push(`${nombre} (normal $${Math.round(pn).toLocaleString('es-CL')} vs venta $${Math.round(precio).toLocaleString('es-CL')})`);
      } else if (pn > precio) {
        precioNormal = Math.round(pn);
      }

      vigenciaHasta = parsearFecha(f.vigencia_hasta);
      if (vigenciaHasta && Date.now() > finDelDiaChile(vigenciaHasta)) {
        oferta = false;
        ofertaVencida = true;
        precioNormal = 0;          // sin oferta no corresponde mostrar tachado
        vencidas.push(`${nombre} (venció el ${vigenciaHasta})`);
      }
    }

    // Antes se filtraba por tipo_bsale = AUTOMOVIL o SIN TIPO. Se sacó: esos
    // valores estaban mal puestos en la planilla y escondían 51 productos
    // vendibles (pañales, huevos por caja, tallarines, comida de mascota de
    // hasta $50.000) sin que se notara — poner activo=SI no bastaba y no
    // había forma de darse cuenta. Ahora manda la columna "activo".
    //
    // Lo que el comercio decidió no vender por la web (2026-07-25): la línea
    // automotriz y el alimento de mascotas, que se despachan sólo en el local
    // por volumen, más los pañales Huggies.
    if (excluidoDeLaWeb(nombre)) { excluidos++; continue; }
    if (precio > PRECIO_MAXIMO) { sospechosos.push(`${nombre} ($${Math.round(precio).toLocaleString('es-CL')})`); continue; }

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
      oferta,
      // Sólo viajan si la oferta está vigente. Así el front no tiene que volver
      // a decidir nada: si viene precioNormal, se muestra tachado.
      descripcion,
      precioNormal: oferta ? precioNormal : 0,
      descuento:    oferta && precioNormal ? Math.round((1 - precio / precioNormal) * 100) : 0,
      vigenciaHasta: oferta ? vigenciaHasta : null,
    });
  }

  cache = { data: productos, ts: ahora };
  console.log(`📦 Google Sheets: ${productos.length} productos activos con precio` +
              ` (${excluidos} excluidos de la web por marca, sacos o venta solo en local)`);
  if (sinStock) console.log(`   ${sinStock} sin stock disponible` + (STOCK_OBLIGATORIO ? ' o sin número asignado' : ''));
  ultimosSospechosos = sospechosos;
  if (sospechosos.length) {
    console.warn(`⚠️ ${sospechosos.length} producto(s) NO publicados por superar $${PRECIO_MAXIMO.toLocaleString('es-CL')} — corregir el precio en la planilla:`);
    sospechosos.forEach(s => console.warn(`     · ${s}`));
  }
  ultimosNormalesInvalidos = normalesInvalidos;
  if (normalesInvalidos.length) {
    console.warn(`⚠️ ${normalesInvalidos.length} precio_normal ignorado(s) por no ser mayor que el precio de venta — sin tachado:`);
    normalesInvalidos.forEach(x => console.warn(`     · ${x}`));
  }
  ultimosPreciosIncoherentes = auditarPreciosPorFormato(paraAuditoria);
  const nInc = ultimosPreciosIncoherentes.avisos.length;
  if (nInc) {
    console.warn(`⚠️ ${nInc} aviso(s) de precios incoherentes entre formatos, en productos A LA VENTA:`);
    ultimosPreciosIncoherentes.avisos.forEach(a => console.warn(`     · ${a}`));
  }
  if (ultimosPreciosIncoherentes.omitidosSinStock) {
    console.log(`   (${ultimosPreciosIncoherentes.omitidosSinStock} aviso(s) más en filas sin stock — se revisan al publicarlas)`);
  }
  ultimasOfertasVencidas = vencidas;
  if (vencidas.length) {
    console.log(`   ${vencidas.length} oferta(s) apagada(s) por vigencia_hasta:`);
    vencidas.forEach(x => console.log(`     · ${x}`));
  }
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
    const { cliente, pago, items, entrega } = req.body;
    if (!cliente?.nombre) return res.status(400).json({ ok: false, error: 'Falta nombre' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'Carrito vacío' });

    const total = items.reduce((s, it) => s + (it.precioUnitario * it.cantidad), 0);

    // Log del pedido
    console.log(`🛒 NUEVO PEDIDO — ${new Date().toISOString()}`);
    console.log(`   Cliente: ${cliente.nombre} | ${cliente.telefono}`);
    console.log(`   Entrega: ${entrega === 'retiro' ? 'RETIRO EN LOCAL' : 'Envío a domicilio'}`);
    console.log(`   Dirección: ${cliente.direccion} — ${cliente.referencia}`);
    console.log(`   Pago: ${pago} | Subtotal productos: $${total.toLocaleString('es-CL')}`);
    items.forEach(it => console.log(`   • ${it.cantidad}x ${it.nombre}`));

    // Confirmación escrita también para transferencia y efectivo, si el
    // cliente dejó su email (art. 12 A Ley 19.496).
    if (cliente.email) {
      const esRetiro = entrega === 'retiro';
      registrarPedido({
        orden: `LB-${Date.now()}`,
        cliente: { nombre: cliente.nombre, telefono: cliente.telefono, email: cliente.email,
                   direccion: cliente.direccion, referencia: cliente.referencia },
        entrega: esRetiro ? 'retiro' : 'envio',
        lineas: items.map(it => ({ n: it.nombre, p: it.precioUnitario, cantidad: it.cantidad, c: it.categoria || '' })),
        subtotal: total,
        despacho: esRetiro ? 0 : (req.body.despacho ?? null),
        km: req.body.km ?? null,
        total: total + (esRetiro ? 0 : (req.body.despacho || 0)),
      }, { medio: pago });
    }

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
// ════════════════════════════════════════════════
//  PREPARAR PEDIDO — compartido por Flow y Webpay
//  Valida los datos del cliente, resuelve cada ítem
//  contra el catálogo real y calcula el total SIEMPRE
//  en el servidor (los precios que envíe el navegador
//  se ignoran). Devuelve { error } o { ok, ...datos }.
// ════════════════════════════════════════════════
// ── ¿El dominio del correo puede recibir mensajes? ────
// Dos motivos para comprobarlo antes de cobrar:
//   1. Flow valida el correo del pagador y, si el dominio no tiene MX, no
//      responde con error: deja la conexión colgada 20 s (medido). El cliente
//      vería el checkout congelado y se iría.
//   2. La confirmación de compra es obligación legal (art. 12 A Ley 19.496):
//      un correo mal escrito la pierde en silencio.
// Pilla los errores de tipeo típicos: @gmial.com, @hotmial.com, @gmail.con.
const cacheMx = new Map(); // dominio -> { valor, hasta }
const MX_TTL  = 6 * 60 * 60 * 1000;

async function dominioRecibeCorreo(email) {
  const dominio = (email.split('@')[1] || '').toLowerCase();
  if (!dominio) return { recibe: false, dominio };

  const guardado = cacheMx.get(dominio);
  if (guardado && guardado.hasta > Date.now()) return guardado.valor;

  let valor;
  try {
    const mx = await Promise.race([
      dns.promises.resolveMx(dominio),
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('timeout')), 4000)),
    ]);
    valor = { recibe: mx.length > 0, dominio };
  } catch (err) {
    // ENOTFOUND y ENODATA son negativas definitivas: ese dominio no recibe
    // correo. Cualquier otra cosa (timeout, DNS caído) es problema nuestro y
    // no puede costarle una venta al cliente, así que se deja pasar sin
    // cachear: se prefiere un correo perdido antes que una compra perdida.
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      valor = { recibe: false, dominio };
    } else {
      console.warn(`⚠️ No se pudo verificar el MX de ${dominio}: ${err.message} — se deja pasar`);
      return { recibe: true, dominio, sinVerificar: true };
    }
  }

  cacheMx.set(dominio, { valor, hasta: Date.now() + MX_TTL });
  if (cacheMx.size > 500) cacheMx.delete(cacheMx.keys().next().value);
  return valor;
}

async function prepararPedido(body, { emailObligatorio = true } = {}) {
  const err = (status, payload) => ({ error: { status, payload: { ok: false, ...payload } } });

  const { cliente, items } = body || {};
  const entrega = body?.entrega === 'retiro' ? 'retiro' : 'envio';

  if (!cliente?.nombre?.trim() || !cliente?.telefono?.trim()) {
    return err(400, { error: 'Faltan datos del cliente' });
  }
  if (entrega === 'envio' && !cliente?.direccion?.trim()) {
    return err(400, { error: 'Falta la dirección para el envío a domicilio' });
  }
  const email = (cliente.email || '').trim();
  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (emailObligatorio && !emailValido) {
    return err(400, { error: 'Email inválido (lo necesitamos para el comprobante)' });
  }
  if (email && !emailValido) {
    return err(400, { error: 'El email no tiene un formato válido' });
  }
  if (emailValido) {
    const mx = await dominioRecibeCorreo(email);
    if (!mx.recibe) {
      return err(400, { error: `El correo no existe: "${mx.dominio}" no recibe mensajes. Revisa que esté bien escrito.` });
    }
  }
  if (!Array.isArray(items) || !items.length || items.length > 200) {
    return err(400, { error: 'Carrito vacío o inválido' });
  }

  // Resolver cada ítem contra el catálogo del servidor (precio real)
  const catalogo = await cargarProductos();
  const porId = new Map(catalogo.map(p => [p.id, p]));
  const lineas = [];
  for (const it of items) {
    const cant = parseInt(it.cantidad);
    if (!cant || cant < 1 || cant > 999) {
      return err(400, { error: 'Cantidad inválida en el carrito' });
    }
    // Los ids se asignan por orden de fila del Sheet: si la planilla cambió
    // entre que el cliente cargó la página y pagó, el id puede apuntar a otra
    // fila. Se verifica por nombre y se recurre a búsqueda exacta si no calza.
    let prod = porId.get(parseInt(it.id));
    if (!prod || (it.n && prod.n !== it.n)) {
      prod = it.n ? catalogo.find(p => p.n === it.n) : null;
    }
    if (!prod) {
      return err(409, { error: 'El catálogo cambió mientras comprabas. Recarga la página e intenta de nuevo.' });
    }
    // El tope de stock se verifica acá y no solo en el navegador: el carrito
    // vive en el cliente y se puede alterar. Es la última barrera antes de
    // cobrarle a alguien algo que no se le puede entregar.
    // stock null = el comercio no lleva control de ese producto, no hay tope.
    if (typeof prod.stock === 'number') {
      if (prod.stock <= 0) {
        return err(409, { error: `"${prod.n}" se agotó mientras comprabas. Sácalo del carrito para continuar.` });
      }
      if (cant > prod.stock) {
        return err(409, { error: `Solo quedan ${prod.stock} ${prod.stock === 1 ? 'unidad' : 'unidades'} de "${prod.n}". Ajusta la cantidad para continuar.` });
      }
    }
    // Se guarda la categoría para poder marcar los perecibles (excluidos
    // del derecho a retracto) en la confirmación por correo.
    lineas.push({ id: prod.id, n: prod.n, p: prod.p, cantidad: cant, c: prod.c || prod.categoria || '' });
  }

  const subtotal = lineas.reduce((s, l) => s + l.p * l.cantidad, 0);

  // Despacho: $0 en retiro en local; según distancia real en envío
  let desp = { metodo: 'retiro', km: null, costo: 0 };
  if (entrega === 'envio') {
    desp = await calcularDespacho(cliente.direccion);
    if (!desp.ok) {
      return err(422, {
        fueraDeCobertura: true, km: desp.km,
        error: `Tu dirección está a ~${desp.km} km de nuestro local — despachamos hasta ${KM_MAX} km. Elige retiro en local o escríbenos por WhatsApp.`,
      });
    }
  }
  const despacho = desp.costo;
  const total    = subtotal + despacho;
  if (total < 350) return err(400, { error: 'El monto mínimo para pagar con tarjeta es $350' });

  // buy_order de Webpay admite máximo 26 caracteres: este formato usa 22.
  const commerceOrder = `LB-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;

  return { ok: true, cliente, entrega, email, lineas, subtotal, despacho, km: desp.km, metodoDespacho: desp.metodo, total, commerceOrder };
}

async function crearPagoFlow(req, res) {
  try {
    if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Pagos con tarjeta no disponibles por ahora. Puedes pagar por transferencia.' });
    }

    const prep = await prepararPedido(req.body, { emailObligatorio: true });
    if (prep.error) return res.status(prep.error.status).json(prep.error.payload);
    const { cliente, entrega, email, lineas, subtotal, despacho, total, commerceOrder } = prep;
    const desp = { km: prep.km, metodo: prep.metodoDespacho, costo: despacho };

    // OJO: Flow muestra este bloque al cliente en su pantalla de pago, con las
    // claves tal cual como etiquetas. Por eso van con nombre completo y los
    // montos ya formateados — antes iban abreviadas (nom, tel, det, sub) y el
    // cliente veía algo que parecía la salida de un programa, no una tienda.
    // Cumple además de respaldo del pedido: si el server se reinicia (plan
    // gratuito de Render) el detalle vuelve desde Flow en la confirmación.
    // Los campos vacíos se omiten: una etiqueta sin valor se ve descuidada.
    const esRetiro = entrega === 'retiro';
    const referencia = (cliente.referencia || '').trim();
    const optional = JSON.stringify(Object.fromEntries(Object.entries({
      'Cliente':   cliente.nombre.trim().slice(0, 60),
      'Teléfono':  cliente.telefono.trim().slice(0, 20),
      'Productos': lineas.map(l => `${l.cantidad}x ${l.n} = ${clp(l.p * l.cantidad)}`).join(' · ').slice(0, 500),
      'Entrega':   esRetiro
        ? 'Retiro en local — Av. Ramón Picarte 779, Valdivia'
        : `Despacho a ${cliente.direccion.trim()}${referencia ? ` (${referencia})` : ''}`.slice(0, 120),
      'Subtotal':  clp(subtotal),
      'Despacho':  esRetiro ? 'Gratis' : clp(despacho),
      'Total':     clp(total),
    }).filter(([, v]) => v !== '' && v != null)));

    const params = {
      apiKey:          FLOW_API_KEY,
      commerceOrder,
      subject:         `Pedido N° ${commerceOrder}`,
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
      // Flow valida el correo del pagador contra el DNS y, con dominios raros,
      // deja la conexión colgada 20 s antes de fallar. Sin tope, el cliente ve
      // el checkout congelado todo ese rato. Mejor fallar rápido y claro.
      timeout: 12000,
    });
    const data = await r.json();
    if (!r.ok || !data.url || !data.token) {
      console.error('❌ Flow payment/create:', r.status, JSON.stringify(data));
      // El 1620 es el rechazo de correo de Flow: hay que decirle al cliente
      // qué arreglar, no darle un error genérico que no lo lleva a ninguna parte.
      const mensaje = data.code === 1620
        ? 'No pudimos validar tu correo. Revisa que esté bien escrito e inténtalo de nuevo.'
        : (data.message || 'No se pudo iniciar el pago. Intenta de nuevo en un momento.');
      return res.status(502).json({ ok: false, error: mensaje });
    }

    pedidosFlow.set(commerceOrder, {
      cliente: { nombre: cliente.nombre, telefono: cliente.telefono, direccion: cliente.direccion || 'RETIRO EN LOCAL', referencia: cliente.referencia || '', email },
      entrega, lineas, subtotal, despacho, km: desp.km, total,
      flowOrder: data.flowOrder, creado: new Date().toISOString(),
    });
    if (pedidosFlow.size > 500) pedidosFlow.delete(pedidosFlow.keys().next().value);

    const detalleDesp = entrega === 'retiro' ? 'retiro en local' : `despacho $${despacho.toLocaleString('es-CL')}${desp.km ? ` a ${desp.km} km` : ' tarifa estándar'}`;
    console.log(`💳 Orden Flow creada: ${commerceOrder} (flowOrder ${data.flowOrder}) — $${total.toLocaleString('es-CL')} (${lineas.length} productos, ${detalleDesp})`);
    res.json({ ok: true, redirect: `${data.url}?token=${data.token}`, commerceOrder, entrega, subtotal, despacho, km: desp.km, metodoDespacho: desp.metodo, total });

  } catch (err) {
    console.error('❌ /api/pago/crear:', err.message);
    res.status(500).json({ ok: false, error: 'Error interno creando el pago' });
  }
}

// ════════════════════════════════════════════════
//  RUTA 6b — POST /api/despacho/calcular
//  Calcula el costo de despacho por distancia para
//  mostrarlo en el checkout antes de pagar.
// ════════════════════════════════════════════════
app.post('/api/despacho/calcular', async (req, res) => {
  try {
    const direccion = (req.body?.direccion || '').trim();
    if (direccion.length < 5) return res.status(400).json({ ok: false, error: 'Escribe una dirección válida' });
    const d = await calcularDespacho(direccion);
    if (!d.ok) {
      return res.json({
        ok: false, fueraDeCobertura: true, km: d.km,
        error: `Tu dirección está a ~${d.km} km — con tarjeta despachamos hasta ${KM_MAX} km. Escríbenos por WhatsApp y lo coordinamos.`,
      });
    }
    res.json({ ok: true, metodo: d.metodo, km: d.km, costo: d.costo });
  } catch (err) {
    console.error('❌ /api/despacho/calcular:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo calcular el despacho' });
  }
});

// ════════════════════════════════════════════════
//  WEBPAY — POST /api/pago/webpay/crear
//  Crea la transacción en Transbank. Devuelve token y
//  url: el front DEBE enviar un form POST con el campo
//  token_ws (no sirve una redirección normal).
// ════════════════════════════════════════════════
async function crearPagoWebpay(req, res) {
  try {
    // Webpay no pide email; se acepta opcional para el comprobante interno.
    // El correo es obligatorio tambien con Webpay: es donde llega la
    // confirmacion escrita que exige el art. 12 A de la Ley 19.496. Sin
    // ella el plazo de retracto del cliente pasa de 10 a 90 dias.
    const prep = await prepararPedido(req.body, { emailObligatorio: true });
    if (prep.error) return res.status(prep.error.status).json(prep.error.payload);
    const { cliente, entrega, email, lineas, subtotal, despacho, total, commerceOrder } = prep;

    const r = await tbkCrear({
      buy_order:  commerceOrder,               // máx 26 caracteres
      session_id: commerceOrder,               // máx 61
      amount:     Math.round(total),           // CLP entero, sin decimales
      return_url: `${PUBLIC_URL}/api/pago/webpay/retorno`,
    });
    if (!r.token || !r.url) {
      console.error('❌ Webpay create sin token/url:', JSON.stringify(r));
      return res.status(502).json({ ok: false, error: 'Webpay no aceptó la transacción. Intenta de nuevo.' });
    }

    pedidosWebpay.set(commerceOrder, {
      buyOrder: commerceOrder, token: r.token, estado: 'pendiente',
      cliente: { nombre: cliente.nombre, telefono: cliente.telefono, direccion: cliente.direccion || 'RETIRO EN LOCAL', referencia: cliente.referencia || '', email },
      entrega, lineas, subtotal, despacho, km: prep.km, total,
      creado: Date.now(),
    });
    tokensWebpay.set(r.token, commerceOrder);
    if (pedidosWebpay.size > 500) {
      const viejo = pedidosWebpay.keys().next().value;
      const p = pedidosWebpay.get(viejo);
      if (p) tokensWebpay.delete(p.token);
      pedidosWebpay.delete(viejo);
    }

    const detalleDesp = entrega === 'retiro' ? 'retiro en local'
      : `despacho $${despacho.toLocaleString('es-CL')}${prep.km ? ` a ${prep.km} km` : ' tarifa estándar'}`;
    console.log(`💳 Transacción Webpay creada: ${commerceOrder} — $${total.toLocaleString('es-CL')} (${lineas.length} productos, ${detalleDesp})`);

    // El front arma el form POST con estos dos valores.
    res.json({ ok: true, pasarela: 'webpay', token: r.token, url: r.url,
               commerceOrder, entrega, subtotal, despacho, km: prep.km, total });

  } catch (err) {
    console.error('❌ /api/pago/webpay/crear:', err.status || '', err.message);
    res.status(502).json({ ok: false, error: 'No se pudo iniciar el pago con tarjeta. Intenta de nuevo o paga por transferencia.' });
  }
}

// ── Rutas de creación de pago ─────────────────────
// Cada pasarela mantiene su ruta propia, y /api/pago/iniciar apunta a la
// que esté activa según PASARELA. Así el checkout no necesita saber cuál
// se está usando: si mañana volvemos a Flow, no se toca el frontend.
app.post('/api/pago/crear',        crearPagoFlow);    // Flow (se conserva)
app.post('/api/pago/webpay/crear', crearPagoWebpay);  // Transbank Webpay Plus
app.post('/api/pago/iniciar', (req, res) =>
  PASARELA === 'flow' ? crearPagoFlow(req, res) : crearPagoWebpay(req, res));

// ════════════════════════════════════════════════
//  WEBPAY — GET+POST /api/pago/webpay/retorno
//  Transbank devuelve el navegador del cliente aquí.
//  Hay 4 escenarios y el ORDEN de evaluación importa:
//  si se evalúa token_ws primero, el escenario 4 se
//  confunde con un pago normal y el commit falla.
// ════════════════════════════════════════════════
function leerParamsTbk(req) {
  const s = { ...(req.query || {}), ...(req.body || {}) };
  return {
    token_ws:         s.token_ws         || null,
    TBK_TOKEN:        s.TBK_TOKEN        || null,
    TBK_ORDEN_COMPRA: s.TBK_ORDEN_COMPRA || null,
    TBK_ID_SESION:    s.TBK_ID_SESION    || s.TBK_ID_SESSION || null, // la doc usa ambas grafías
  };
}
const alFront = (estado, orden, vale) =>
  `${FRONTEND_REDIRECT}/?pago=${estado}`
  + (orden ? `&orden=${encodeURIComponent(orden)}` : '')
  + (vale  ? `&v=${vale}` : '');

// ── COMPROBANTE DE PAGO ───────────────────────────
// Transbank EXIGE que el comercio muestre un comprobante al cliente
// (con Webpay Plus REST ya no existe el voucher de Transbank). Los datos
// se guardan bajo un id aleatorio y el front los pide para renderizarlos:
// así no viajan en la URL ni quedan en el historial del navegador.
const comprobantes = new Map(); // id -> { datos, expira }
const COMPROBANTE_TTL = 60 * 60 * 1000; // 1 hora

// `extra` deja que cada pasarela sobreescriba lo suyo: Flow no entrega código
// de autorización ni los últimos 4 dígitos, pero sí el medio de pago usado.
function guardarComprobante(r, ped, extra = {}) {
  const id = crypto.randomBytes(16).toString('hex');
  comprobantes.set(id, {
    expira: Date.now() + COMPROBANTE_TTL,
    datos: {
      ...extra,
      comercio:      'Distribuidora La Barata — Sociedad Comercial FAF SpA',
      orden:         r.buy_order,
      monto:         r.amount,
      moneda:        'CLP',
      autorizacion:  r.authorization_code || null,
      fecha:         r.transaction_date || new Date().toISOString(),
      tipoPago:      TBK_PAYMENT_TYPE[r.payment_type_code] || r.payment_type_code || null,
      tipoPagoCodigo: r.payment_type_code || null,
      cuotas:        r.installments_number || 0,
      montoCuota:    r.installments_amount || 0,
      ultimos4:      r.card_detail?.card_number || null,
      // Descripción de los bienes: exigida por Transbank en el comprobante
      productos:     ped ? ped.lineas.map(l => ({ n: l.n, cantidad: l.cantidad, precio: l.p, subtotal: l.p * l.cantidad })) : [],
      subtotal:      ped ? ped.subtotal : null,
      despacho:      ped ? ped.despacho : null,
      entrega:       ped ? ped.entrega  : null,
      km:            ped ? ped.km       : null,
      cliente:       ped ? { nombre: ped.cliente.nombre, telefono: ped.cliente.telefono,
                             direccion: ped.entrega === 'retiro' ? null : ped.cliente.direccion,
                             referencia: ped.entrega === 'retiro' ? null : ped.cliente.referencia } : null,
      ...extra,
    },
  });
  // Limpieza de comprobantes vencidos
  if (comprobantes.size > 300) {
    const ahora = Date.now();
    for (const [k, v] of comprobantes) if (v.expira < ahora) comprobantes.delete(k);
  }
  return id;
}

app.get('/api/pago/comprobante/:id', (req, res) => {
  const c = comprobantes.get(req.params.id);
  if (!c || c.expira < Date.now()) {
    return res.status(404).json({ ok: false, error: 'Comprobante no disponible' });
  }
  res.json({ ok: true, comprobante: c.datos });
});

async function manejarRetornoWebpay(req, res) {
  const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = leerParamsTbk(req);
  try {
    // ESC. 4 — error en el formulario: llegan AMBOS tokens. Va primero.
    if (token_ws && TBK_TOKEN) {
      console.log(`⚠️ Webpay: error de formulario — orden ${TBK_ORDEN_COMPRA}`);
      marcarWebpay(TBK_ORDEN_COMPRA, 'fallida');
      return res.redirect(302, alFront('error', TBK_ORDEN_COMPRA));
    }
    // ESC. 3 — el cliente apretó "Anular compra". NUNCA hacer commit acá.
    if (TBK_TOKEN && !token_ws) {
      console.log(`⚠️ Webpay: pago anulado por el cliente — orden ${TBK_ORDEN_COMPRA}`);
      marcarWebpay(TBK_ORDEN_COMPRA, 'cancelada');
      return res.redirect(302, alFront('rechazado', TBK_ORDEN_COMPRA));
    }
    // ESC. 2 — timeout del formulario: no llega ningún token.
    if (!token_ws && TBK_ORDEN_COMPRA) {
      console.log(`⚠️ Webpay: timeout del formulario — orden ${TBK_ORDEN_COMPRA}`);
      marcarWebpay(TBK_ORDEN_COMPRA, 'expirada');
      return res.redirect(302, alFront('pendiente', TBK_ORDEN_COMPRA));
    }
    if (!token_ws) return res.redirect(302, alFront('error'));

    // ESC. 1 — flujo normal
    const buyOrder = tokensWebpay.get(token_ws);
    const ped      = buyOrder ? pedidosWebpay.get(buyOrder) : null;

    // Idempotencia: el commit es de UN SOLO USO. Si el cliente recarga (F5),
    // el segundo PUT da 422 y mostraríamos "rechazado" a alguien que sí pagó.
    if (ped && ped.estado !== 'pendiente') {
      // Si ya estaba pagada, se vuelve a emitir el comprobante para que el
      // cliente lo tenga aunque haya recargado la página.
      const vale = ped.estado === 'pagada' && ped.respuesta ? guardarComprobante(ped.respuesta, ped) : null;
      return res.redirect(302, alFront(ped.estado === 'pagada' ? 'exitoso' : 'rechazado', buyOrder, vale));
    }

    let r;
    try {
      r = await tbkCommit(token_ws);          // ← esto es lo que captura el dinero
    } catch (err) {
      // 422 = token ya consumido; se consulta el endpoint idempotente antes de
      // dar el pago por perdido.
      console.error(`⚠️ Webpay commit falló (${err.status}): ${err.message} — consultando estado`);
      try { r = await tbkStatus(token_ws); }
      catch (e2) {
        console.error('❌ Webpay status también falló:', e2.message);
        return res.redirect(302, alFront('error', buyOrder));
      }
    }

    // Regla oficial: AMBAS condiciones. No se valida `vci` (la doc lo prohíbe).
    const aprobada = r.response_code === 0 && r.status === 'AUTHORIZED';
    // Defensa propia: el monto y la orden deben calzar con lo que registramos.
    const montoOk  = !ped || Math.round(ped.total) === r.amount;
    const ordenOk  = !ped || ped.buyOrder === r.buy_order;

    if (aprobada && montoOk && ordenOk) {
      marcarWebpay(r.buy_order, 'pagada', r);
      console.log(`✅ PAGO WEBPAY CONFIRMADO — ${r.buy_order} — $${Number(r.amount).toLocaleString('es-CL')} — auth ${r.authorization_code} — ${TBK_PAYMENT_TYPE[r.payment_type_code] || r.payment_type_code} — ****${r.card_detail?.card_number || '????'}`);
      if (ped) {
        console.log(`   Cliente: ${ped.cliente.nombre} | ${ped.cliente.telefono}${ped.cliente.email ? ' | ' + ped.cliente.email : ''}`);
        console.log(`   Entrega: ${ped.entrega === 'retiro' ? 'RETIRO EN LOCAL' : ped.cliente.direccion + ' — ' + ped.cliente.referencia}`);
        ped.lineas.forEach(l => console.log(`   • ${l.cantidad}x ${l.n} — $${(l.p * l.cantidad).toLocaleString('es-CL')}`));
        console.log(`   Subtotal $${ped.subtotal.toLocaleString('es-CL')} + Despacho $${ped.despacho.toLocaleString('es-CL')}`);
      }
      // Confirmación escrita (art. 12 A Ley 19.496). No se espera la
      // respuesta: Transbank exige responder rápido y la venta ya está hecha.
      if (ped) registrarPedido(ped, {
        medio: `Tarjeta ${TBK_PAYMENT_TYPE[r.payment_type_code] || ''}`.trim() + (r.card_detail?.card_number ? ` ****${r.card_detail.card_number}` : ''),
        autorizacion: r.authorization_code,
      });
      const vale = guardarComprobante(r, ped);
      return res.redirect(302, alFront('exitoso', r.buy_order, vale));
    }

    if (aprobada && (!montoOk || !ordenOk)) {
      // Cobró pero no calza con nuestra orden: devolver el dinero de inmediato.
      console.error(`🚨 Webpay DESCALCE — esperado $${ped?.total} orden ${ped?.buyOrder} / recibido $${r.amount} orden ${r.buy_order}`);
      try { await tbkRefund(token_ws, r.amount); } catch (e) { console.error('❌ refund falló:', e.message); }
      marcarWebpay(r.buy_order, 'fallida', r);
      return res.redirect(302, alFront('error', r.buy_order));
    }

    console.log(`⚠️ Pago Webpay RECHAZADO — ${r.buy_order} — código ${r.response_code} (${TBK_RESPONSE_CODE[r.response_code] || '?'}) — estado ${r.status}`);
    marcarWebpay(r.buy_order, 'rechazada', r);
    return res.redirect(302, alFront('rechazado', r.buy_order));

  } catch (err) {
    console.error('❌ /api/pago/webpay/retorno:', err.message);
    return res.redirect(302, alFront('error'));
  }
}
app.post('/api/pago/webpay/retorno', manejarRetornoWebpay);
app.get ('/api/pago/webpay/retorno', manejarRetornoWebpay);

// ── RECONCILIACIÓN ────────────────────────────────
// Webpay NO tiene webhook: si el navegador del cliente muere después de
// pagar, el servidor nunca se entera. Este barrido consulta el estado real
// de las órdenes que quedaron pendientes.
async function reconciliarWebpay() {
  const ahora = Date.now();
  for (const [buyOrder, p] of pedidosWebpay) {
    if (p.estado !== 'pendiente') continue;
    const edad = ahora - p.creado;
    if (edad < 15 * 60 * 1000) continue;               // margen para el flujo normal
    if (edad > 7 * 24 * 3600 * 1000) { marcarWebpay(buyOrder, 'expirada'); continue; }
    try {
      const s = await tbkStatus(p.token);
      if (s.response_code === 0 && s.status === 'AUTHORIZED') {
        marcarWebpay(buyOrder, 'pagada', s);
        console.log(`✅ WEBPAY RECONCILIADO — ${buyOrder} quedó pagada sin que el cliente volviera — $${Number(s.amount).toLocaleString('es-CL')}`);
        console.log(`   Cliente: ${p.cliente.nombre} | ${p.cliente.telefono} | ${p.entrega === 'retiro' ? 'RETIRO EN LOCAL' : p.cliente.direccion}`);
      } else if (s.status === 'INITIALIZED') {
        if (edad > 60 * 60 * 1000) marcarWebpay(buyOrder, 'expirada');
      } else {
        marcarWebpay(buyOrder, 'rechazada', s);
      }
    } catch (err) {
      if (err.status === 404) marcarWebpay(buyOrder, 'fallida');
      else console.error(`⚠️ reconciliación ${buyOrder}:`, err.message);
    }
  }
}
setInterval(reconciliarWebpay, 10 * 60 * 1000);

// ════════════════════════════════════════════════
//  RUTA 7 — POST /api/pago/confirmacion
//  Webhook servidor-a-servidor de Flow. Debe responder
//  200 rápido (<15s). El estado SIEMPRE se valida con
//  getStatus — nunca por la sola llegada del POST.
// ════════════════════════════════════════════════
// En el plan gratuito de Render el proceso se reinicia por inactividad y
// pedidosFlow queda vacío. Cuando llega la confirmación de un pago cuyo pedido
// ya no está en memoria, se reconstruye desde el respaldo que viajó en Flow:
// sin esto el cliente paga y no recibe la confirmación escrita que exige la
// ley. Los montos se recuperan del texto porque es el mismo formato que
// escribimos nosotros al crear el cobro.
async function reconstruirPedidoDeFlow(pago) {
  let o;
  try { o = typeof pago.optional === 'string' ? JSON.parse(pago.optional) : pago.optional; }
  catch (e) { return null; }
  if (!o || !o['Productos']) return null;

  const aNumero = (s) => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;

  // La categoría no viaja en el respaldo (se le mostraría al cliente en la
  // pantalla de Flow), así que se busca en el catálogo para no perder el aviso
  // de los productos sin derecho a retracto.
  let porNombre = new Map();
  try {
    const catalogo = await cargarProductos();
    porNombre = new Map(catalogo.map(p => [p.n.toUpperCase(), p.c]));
  } catch (e) { /* sin catálogo se envía igual, solo sin la marca de perecible */ }

  const lineas = String(o['Productos']).split(' · ').map(txt => {
    const m = txt.match(/^(\d+)x\s+(.+?)\s+=\s+\$([\d.]+)$/);
    if (!m) return null;
    const cantidad = parseInt(m[1], 10);
    const nombre   = m[2].trim();
    const total    = aNumero(m[3]);
    return { n: nombre, cantidad, p: Math.round(total / (cantidad || 1)),
             c: porNombre.get(nombre.toUpperCase()) || '' };
  }).filter(Boolean);
  if (!lineas.length) return null;

  const esRetiro = /Retiro en local/i.test(o['Entrega'] || '');
  return {
    orden:    pago.commerceOrder,
    cliente:  { nombre: o['Cliente'] || '', telefono: o['Teléfono'] || '',
                email: pago.payer || '',
                direccion: esRetiro ? '' : String(o['Entrega'] || '').replace(/^Despacho a\s+/, ''),
                referencia: '' },
    entrega:  esRetiro ? 'retiro' : 'envio',
    lineas,
    subtotal: aNumero(o['Subtotal']),
    despacho: esRetiro ? 0 : aNumero(o['Despacho']),
    total:    aNumero(o['Total']) || Number(pago.amount) || 0,
    km:       null,
  };
}

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
        // Confirmación escrita (art. 12 A Ley 19.496). Faltaba: el correo salía
        // en transferencia y en Webpay, pero no en Flow, así que quien pagaba
        // con tarjeta por Flow se quedaba sin comprobante escrito.
        registrarPedido({ ...ped, orden: pago.commerceOrder },
                           { medio: `Tarjeta${pago.paymentData?.media ? ` (${pago.paymentData.media})` : ''}` });
      } else {
        // El server se reinició y perdió el pedido: se rearma con el respaldo
        // que viajó en Flow para no dejar al cliente sin confirmación escrita.
        const rearmado = await reconstruirPedidoDeFlow(pago);
        if (rearmado) {
          console.log(`   (recuperado de Flow) Cliente: ${rearmado.cliente.nombre} | ${rearmado.cliente.telefono} | ${rearmado.cliente.email}`);
          rearmado.lineas.forEach(l => console.log(`   • ${l.cantidad}x ${l.n} — $${(l.p * l.cantidad).toLocaleString('es-CL')}`));
          registrarPedido(rearmado,
                             { medio: `Tarjeta${pago.paymentData?.media ? ` (${pago.paymentData.media})` : ''}` });
        } else {
          console.warn(`   ⚠️ Pedido ${pago.commerceOrder} no está en memoria y el respaldo de Flow no se pudo leer — SIN correo de confirmación:`, pago.optional);
        }
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
      const pago = await flowGetStatus(token);
      if (pago.status === 2) {
        // Mismo comprobante con logo que ya mostraba Webpay: el cliente que
        // paga por Flow terminaba en la página pelada, sin ningún respaldo
        // visible de su compra.
        const ped  = pedidosFlow.get(pago.commerceOrder);
        const vale = guardarComprobante({
          buy_order:        pago.commerceOrder,
          amount:           pago.amount,
          transaction_date: pago.paymentData?.date || new Date().toISOString(),
        }, ped, {
          // Flow no entrega código de autorización ni los últimos 4 dígitos;
          // su número de orden es el respaldo que sí puede exhibir el cliente.
          autorizacion: pago.flowOrder ? `Flow N° ${pago.flowOrder}` : null,
          tipoPago:     pago.paymentData?.media || 'Tarjeta',
          ultimos4:     null,
        });
        destino = alFront('exitoso', pago.commerceOrder, vale);
      } else {
        destino = alFront(pago.status === 1 ? 'pendiente' : 'rechazado', pago.commerceOrder);
      }
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
// Diagnóstico del correo: comprueba de verdad, desde Render, que el
// proveedor responde, y muestra cómo terminó el último envío. No expone
// ninguna credencial. Leer así cuando falle el correo:
//   • vía brevo, conexion.ok false con status 401 → la API key está mala
//   • vía smtp, 465 en timeout y 443 abierto → el hosting bloquea el SMTP
//   • vía smtp, 465 abierto y error EAUTH → la contraseña está mala
app.get('/api/diagnostico/correo', async (req, res) => {
  const info = {
    configurado: CORREO_ACTIVO,
    via: VIA_BREVO ? 'brevo (API HTTPS)' : (VIA_SMTP ? 'smtp' : 'ninguna'),
    remitente: REMITENTE,
    copiaComercio: CORREO_COMERCIO,
    ultimoEnvio: ultimoCorreo,
  };
  if (VIA_SMTP) {
    Object.assign(info, {
      usuario: SMTP_USER || null, host: SMTP_HOST, puerto: SMTP_PORT,
      clavePresente: !!SMTP_PASS,
      largoClave: SMTP_PASS.length, // Gmail entrega 16; 19 = se pegó con espacios
      claveConEspacios: /\s/.test(SMTP_PASS),
    });
  }

  if (!CORREO_ACTIVO) {
    return res.json({ ...info, conexion: { ok: false, error: 'falta BREVO_API_KEY (o SMTP_USER y SMTP_PASS)' } });
  }

  // A qué IP resuelve el proveedor: si aparece una IPv6 primero, volvió el
  // ENETUNREACH que ya nos costó una tarde.
  const hostDiag = VIA_BREVO ? new URL(BREVO_API_URL).hostname : SMTP_HOST;
  try {
    const dirs = await dns.promises.lookup(hostDiag, { all: true });
    info.resuelveA = dirs.map(d => `IPv${d.family}: ${d.address}`);
  } catch (err) {
    info.resuelveA = `error de DNS: ${err.message}`;
  }

  // Sonda de puertos: distingue "clave mala" de "el hosting bloquea SMTP".
  // El 443 es el control — si ese también falla, el problema es otro.
  if (req.query.puertos === '1') {
    const probar = (host, puerto) => new Promise(resolve => {
      const t = Date.now();
      const s = new net.Socket();
      const fin = (r) => { s.destroy(); resolve(`${puerto}: ${r} (${Date.now() - t}ms)`); };
      s.setTimeout(8000);
      s.once('connect', () => fin('ABIERTO'));
      s.once('timeout', () => fin('timeout'));
      s.once('error',   (e) => fin(e.code || e.message));
      s.connect({ port: puerto, host, family: 4 });
    });
    info.sondaPuertos = await Promise.all([
      probar(SMTP_HOST, 25), probar(SMTP_HOST, 465),
      probar(SMTP_HOST, 587), probar('www.google.com', 443),
    ]);
  }

  const t0 = Date.now();
  try {
    if (VIA_BREVO) {
      // /v3/account valida la API key sin gastar un envío del cupo diario.
      const r = await fetch(`${BREVO_API_URL}/account`, {
        headers: { 'api-key': BREVO_API_KEY, accept: 'application/json' }, timeout: 15000,
      });
      const cuerpo = await r.json().catch(() => ({}));
      res.json({ ...info, conexion: {
        ok: r.ok, ms: Date.now() - t0, status: r.status,
        cuenta: cuerpo.email || null,
        plan: Array.isArray(cuerpo.plan) ? cuerpo.plan.map(p => `${p.type} ${p.credits ?? ''}`.trim()) : null,
        error: r.ok ? undefined : (cuerpo.message || `HTTP ${r.status}`),
      }});
    } else {
      await transporter.verify();
      res.json({ ...info, conexion: { ok: true, ms: Date.now() - t0 } });
    }
  } catch (err) {
    res.json({ ...info, conexion: {
      ok: false, ms: Date.now() - t0,
      error: err.message, codigo: err.code, comando: err.command, respuestaSmtp: err.response,
    }});
  }
});

// Diagnóstico de Flow. Soporte respondió (ticket 167156) que el error 1620
// "userEmail is not valid" viene de que validan el correo del pagador:
// formato, que el dominio tenga MX y que la casilla exista. Esto lo comprueba
// en vez de creerlo: revisa el MX del dominio y, con ?probar=1, hace una
// llamada real a payment/create. Sin ?probar=1 no tiene efectos: solo informa.
// Nunca expone las llaves.
app.get('/api/diagnostico/flow', async (req, res) => {
  const email = (req.query.email || '').trim();
  const info = {
    configurado: !!(FLOW_API_KEY && FLOW_SECRET_KEY),
    ambiente: FLOW_API_URL.includes('sandbox') ? 'sandbox' : 'produccion',
    apiUrl: FLOW_API_URL,
    largoApiKey: FLOW_API_KEY.length,
    largoSecretKey: FLOW_SECRET_KEY.length,
    pasarelaActiva: PASARELA,
    emailProbado: email || null,
  };

  if (!info.configurado) {
    return res.json({ ...info, error: 'faltan FLOW_API_KEY o FLOW_SECRET_KEY' });
  }
  if (!email) {
    return res.json({ ...info, ayuda: 'agrega ?email=alguien@dominio.cl y ?probar=1 para llamar a payment/create' });
  }

  // La validación que declara Flow: el dominio del correo debe tener MX.
  const dominio = email.split('@')[1] || '';
  try {
    const mx = await dns.promises.resolveMx(dominio);
    info.mx = { ok: mx.length > 0, dominio, servidores: mx.map(m => m.exchange) };
  } catch (err) {
    info.mx = { ok: false, dominio, error: `sin MX [${err.code}] — Flow rechazaría este correo` };
  }

  if (req.query.probar !== '1') {
    return res.json({ ...info, nota: 'agrega &probar=1 para llamar de verdad a payment/create' });
  }

  // Llamada real, con el monto mínimo y una orden marcada como diagnóstico.
  // Crea un cobro pendiente que nadie paga; no mueve dinero.
  const params = {
    apiKey:          FLOW_API_KEY,
    commerceOrder:   `DIAG-${Date.now()}`,
    subject:         'Diagnostico de integracion',
    currency:        'CLP',
    amount:          350,
    email,
    paymentMethod:   9,
    urlConfirmation: `${PUBLIC_URL}/api/pago/confirmacion`,
    urlReturn:       `${PUBLIC_URL}/api/pago/retorno`,
  };
  params.s = firmarFlow(params);

  const t0 = Date.now();
  try {
    const r = await fetch(`${FLOW_API_URL}/payment/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      timeout: 20000,
    });
    const data = await r.json().catch(() => ({}));
    res.json({ ...info, paymentCreate: {
      ok: r.ok && !!data.url, ms: Date.now() - t0, status: r.status,
      codigoError: data.code, mensaje: data.message,
      urlDePago: data.url ? data.url + '?token=' + data.token : null,
    }});
  } catch (err) {
    res.json({ ...info, paymentCreate: { ok: false, ms: Date.now() - t0, error: err.message } });
  }
});

// Diagnóstico del catálogo: qué se está publicando y qué quedó retenido.
// Evita tener que bucear en los logs de Render para saber por qué un
// producto no aparece en el sitio.
// Igual que los de correo y Flow: saber si el registro está enchufado y cómo
// terminó el último intento, sin tener que entrar a los logs de Render.
// ?probar=1 escribe una fila de prueba, marcada como tal.
app.get('/api/diagnostico/pedidos', async (req, res) => {
  const info = {
    configurado: !!PEDIDOS_SHEET_URL,
    urlPresente: !!PEDIDOS_SHEET_URL,
    tokenPresente: !!PEDIDOS_SHEET_TOKEN,
    esWebAppDeAppsScript: /script\.google\.com\/.*\/exec$/.test(PEDIDOS_SHEET_URL),
    ultimoRegistro: ultimoRegistroPlanilla,
  };
  if (!PEDIDOS_SHEET_URL) {
    return res.json({ ...info, error: 'falta PEDIDOS_SHEET_URL en Render',
                      ayuda: 'pegar la URL /exec del Web App de Apps Script' });
  }
  if (!req.query.probar) {
    return res.json({ ...info, ayuda: 'agrega ?probar=1 para escribir una fila de prueba' });
  }
  await anotarEnPlanilla({
    orden: `PRUEBA-${Date.now()}`,
    entrega: 'retiro',
    cliente: { nombre: 'PRUEBA — borrar esta fila', telefono: '-', email: '', direccion: '-', referencia: '-' },
    lineas: [{ n: 'Fila de prueba del diagnóstico', p: 0, cantidad: 1 }],
    subtotal: 0, despacho: 0, total: 0, km: null,
  }, { medio: 'prueba' });
  res.json({ ...info, ultimoRegistro: ultimoRegistroPlanilla });
});

app.get('/api/diagnostico/catalogo', async (req, res) => {
  try {
    const productos = await cargarProductos();
    res.json({
      publicados: productos.length,
      // Para saber de un vistazo si la columna "oferta" (K) está haciendo algo.
      // Si sale 0, o no hay ninguna fila marcada o la columna no se llama
      // exactamente "oferta" en la primera fila de la planilla.
      enOferta: productos.filter(p => p.oferta).length,
      // Si sale 0, o no hay ninguna fila escrita o la columna no se llama
      // exactamente "descripcion" en la primera fila de la planilla.
      conDescripcion: productos.filter(p => p.descripcion).length,
      productosEnOferta: productos.filter(p => p.oferta).map(p =>
        `${p.n} ($${p.p.toLocaleString('es-CL')}` +
        (p.precioNormal ? ` antes $${p.precioNormal.toLocaleString('es-CL')}, -${p.descuento}%` : '') +
        (p.vigenciaHasta ? `, hasta ${p.vigenciaHasta}` : '') + ')'),
      ofertasVencidas: ultimasOfertasVencidas,
      // Precios que no cuadran entre formatos del mismo producto. Incluye filas
      // sin publicar: la idea es corregirlas antes de cargarles stock.
      preciosIncoherentes: ultimosPreciosIncoherentes,
      precioNormalIgnorado: ultimosNormalesInvalidos,
      notaOfertas: 'Al vencer vigencia_hasta se apaga la oferta (badge, tachado y sección), pero el PRECIO no cambia: sigue mandando la columna "precio".',
      precioMaximo: PRECIO_MAXIMO,
      retenidosPorPrecio: ultimosSospechosos,
      excluidosDeLaWeb: 'línea automotriz, alimento de mascotas y pañales Huggies (se venden solo en el local)',
      nota: 'Un producto no aparece si: activo ≠ SI, no tiene precio, está en la lista de excluidos, o su precio supera el máximo.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ping', (req, res) => {
  res.json({
    ok:      true,
    status:  'Servidor La Barata activo 🟢',
    version: '7.0.0 — Google Sheets',
    pasarela: PASARELA,
    ambiente: PASARELA === 'webpay' ? (TBK_PROD ? 'produccion' : 'integracion') : (FLOW_API_URL.includes('sandbox') ? 'sandbox' : 'produccion'),
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
