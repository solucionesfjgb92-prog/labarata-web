# Registro de pedidos en planilla — cómo se enchufa

El sitio ya manda cada pedido confirmado a una planilla, además del correo.
Falta crear la planilla y pegar la URL en Render. Son 10 minutos, una sola vez.

Por qué se hace con Apps Script y no con la API de Google Sheets: así no hay
que meter credenciales de cuenta de servicio en Render, igual que el catálogo,
que ya se lee por URL publicada. Además sale por HTTPS/443, que es lo único que
el plan gratuito de Render deja salir (los puertos de correo están bloqueados).

---

## 1. Crear la planilla

Nueva hoja de cálculo en Drive, llamada por ejemplo **PEDIDOS LA BARATA**.
No hay que escribir encabezados: el script los crea solo la primera vez.

## 2. Pegar el script

En esa planilla: **Extensiones → Apps Script**. Borra lo que haya y pega esto.

Cambia `CLAVE` por una palabra secreta cualquiera (la misma que va en Render).

```javascript
// Recibe los pedidos del sitio y agrega una fila por cada uno.
const CLAVE = 'cambia-esto-por-una-clave-larga';

const COLUMNAS = [
  'fecha', 'orden', 'medio', 'entrega', 'nombre', 'telefono', 'email',
  'direccion', 'referencia', 'km', 'subtotal', 'despacho', 'total',
  'unidades', 'detalle',
];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);

    // Sin la clave correcta no se escribe nada: la URL del Web App queda
    // abierta a cualquiera que la tenga, así que la clave es la que manda.
    if (d.token !== CLAVE) {
      return ContentService.createTextOutput('error: token invalido');
    }

    const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // Encabezados la primera vez, y se congela la fila para que no se pierda
    // al hacer scroll.
    if (hoja.getLastRow() === 0) {
      hoja.appendRow(COLUMNAS);
      hoja.setFrozenRows(1);
      hoja.getRange(1, 1, 1, COLUMNAS.length).setFontWeight('bold');
    }

    hoja.appendRow(COLUMNAS.map(function (c) {
      return d[c] === undefined || d[c] === null ? '' : d[c];
    }));

    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err.message);
  }
}
```

## 3. Publicarlo

**Implementar → Nueva implementación → Aplicación web**

- Ejecutar como: **Yo**
- Quién tiene acceso: **Cualquier persona**

Google va a pedir permisos la primera vez; hay que aceptarlos.

Copia la URL que queda. Termina en `/exec`, así:

```
https://script.google.com/macros/s/AKfycb.../exec
```

> "Cualquier persona" suena feo pero es necesario: el servidor de Render llama
> sin sesión de Google. Por eso está la clave — sin ella el script no escribe.

## 4. Pegar las dos variables en Render

En el servicio del backend, **Environment**:

| Variable | Valor |
|---|---|
| `PEDIDOS_SHEET_URL` | la URL que termina en `/exec` |
| `PEDIDOS_SHEET_TOKEN` | la misma palabra secreta que pusiste en `CLAVE` |

Render reinicia solo al guardar.

## 5. Comprobar

Abre esto en el navegador — escribe una fila de prueba en la planilla:

```
https://labarata-backend.onrender.com/api/diagnostico/pedidos?probar=1
```

Si responde `"ok": true` y aparece la fila que dice
**"PRUEBA — borrar esta fila"**, está funcionando. Borra esa fila y listo.

Sin el `?probar=1` el mismo endpoint dice si está configurado y cómo terminó el
último pedido real, sin escribir nada.

---

## Qué queda registrado

Una fila por pedido confirmado, con: fecha, número de orden, medio de pago,
retiro o despacho, nombre, teléfono, correo, dirección, referencia, kilómetros,
subtotal, costo de despacho, total, unidades y el detalle de los productos en
una sola celda.

Entra por los cuatro caminos de pago: tarjeta por Flow, tarjeta por Webpay,
transferencia y efectivo. **El registro no depende del correo**: si el cliente
no deja email no le llega comprobante, pero el pedido igual queda anotado.

Si la planilla falla, la venta no se cae: el pedido sigue su curso y el
problema queda en el log de Render y en el diagnóstico.
