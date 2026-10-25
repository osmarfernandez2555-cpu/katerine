// Citas de Katerin — Node + Express + PostgreSQL (Railway)
// Cada servicio tiene sus propios horarios y cada horario es independiente:
// reservar Alisado 8:30 no ocupa Balayage 8:30.
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Katerin123";
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error("Falta la variable DATABASE_URL. Agregá PostgreSQL en Railway y referenciala.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes("railway.internal") || DB_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Servicios y horarios por defecto ----------
const SERVICIOS = {
  alisado: { nombre: "Alisado", horas: [] },          // alisado, tinte y tratamiento usan los TURNOS compartidos
  balayage: { nombre: "Balayage", horas: ["08:30"] },
  tinte: { nombre: "Tinte", horas: [] },
  tratamiento: { nombre: "Tratamientos", horas: [] },
};
// Turnos compartidos por alisado, tinte y tratamiento (la administradora los cambia desde el panel)
const TURNOS0 = ["08:30", "09:30", "11:00", "13:00"];
// Precios por defecto (la administradora los cambia desde el panel → Precios)
const PRECIOS0 = { alisado: 9, tinte: 5, balayage: { corto: 60, medio: 85, largo: 100 }, balayageB: { corto: 65, medio: 90, largo: 120 }, tratamiento: { corto: 15, medio: 20, largo: 25 } };
const SKEYS = Object.keys(SERVICIOS);

// dias: días cerrados / servicios activos · turnos: reservas · config: horarios · clientes: base de clientas
const COLLS = ["dias", "turnos", "config", "clientes"];
const ID_RE = {
  dias: /^\d{4}-\d{2}-\d{2}$/,
  turnos: new RegExp("^\\d{4}-\\d{2}-\\d{2}_(" + SKEYS.join("|") + ")_\\d{4}$"),
  config: /^(horarios|precios)$/,
  clientes: /^c\d{6,16}$/,
};
const SOLO_ADMIN_LECTURA = ["clientes"];
// Tratamientos: tipo y largo de cabello (precio del tratamiento completo según el largo)
// Servicios con opciones: tipo y largo de cabello (precio según el largo)
const OPCIONES = {
  tratamiento: {
    tipos: { recon: "Reconstrucción, nutrición e hidratación", sos: "Tratamiento SOS", detox: "Detox capilar" },
    largos: { corto: ["Por encima de los hombros"], medio: ["A mitad de espalda"], largo: ["Casi llegando a la espalda baja"] },
  },
  balayage: {
    tipos: { lacio: "Balayage morena iluminada", rizado: "Balayage morena iluminada, cabello rizado", corto: "Balayage" },
    largos: { corto: ["Corto, por encima de los hombros"], medio: ["Mediano, hasta mitad de espalda"], largo: ["Largo"] },
    largosPorTipo: { corto: { corto: ["Corto, por encima de los hombros"], medio: ["Mediano, hasta mitad de espalda"], largo: ["Largo"] } }, // "Balayage" tiene sus propios precios
  },
};
function largosDe(serv, tipo) {
  const op = OPCIONES[serv];
  return (op.largosPorTipo && op.largosPorTipo[tipo]) || op.largos;
}
function precioDe(P, serv, tipo, largo) {
  if (serv === "balayage") return tipo === "corto" ? P.balayageB[largo] : P.balayage[largo];
  if (serv === "tratamiento") return P.tratamiento[largo];
  return null;
}
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const isAdmin = (req) => req.get("x-admin") === ADMIN_PASSWORD;
const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
// Nombres con la inicial de cada palabra en mayúscula
const capNombre = (n) => String(n || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es").replace(/(^|[\s\-'’])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase("es"));
const soloDigitos = (v, max) => String(v || "").replace(/\D/g, "").slice(0, max);

// Las clientas solo ven que un horario está ocupado; nombre y teléfono solo los ve la administradora o la dueña de la cita
function visible(coll, data, req) {
  if (coll !== "turnos" || isAdmin(req)) return data;
  const uid = String(req.query.uid || "");
  if (uid && data.uid === uid) return data;
  return { fecha: data.fecha, serv: data.serv, hora: data.hora };
}

function checkParams(req, res) {
  const { coll, id } = req.params;
  if (!COLLS.includes(coll)) { res.status(404).json({ error: "colección inválida" }); return false; }
  if (id !== undefined && !ID_RE[coll].test(id)) { res.status(400).json({ error: "id inválido" }); return false; }
  if (SOLO_ADMIN_LECTURA.includes(coll) && !isAdmin(req)) { res.status(403).json({ error: "solo administradora" }); return false; }
  return true;
}

async function horariosActuales() {
  const { rows } = await pool.query("SELECT data FROM docs WHERE coll = 'config' AND id = 'horarios'");
  const d = rows.length ? rows[0].data : {};
  return {
    balayage: Array.isArray(d.balayage) ? d.balayage : SERVICIOS.balayage.horas,
    turnos: Array.isArray(d.turnos) ? d.turnos : TURNOS0,
  };
}
async function preciosActuales() {
  const { rows } = await pool.query("SELECT data FROM docs WHERE coll = 'config' AND id = 'precios'");
  const d = rows.length ? rows[0].data : {};
  const num = (v, def) => (typeof v === "number" && v >= 0 && v < 10000 ? v : def);
  const P = JSON.parse(JSON.stringify(PRECIOS0));
  P.alisado = num(d.alisado, P.alisado); P.tinte = num(d.tinte, P.tinte); P.balayageB.corto = num(d.balayageCorto, P.balayageB.corto); // precio viejo de "cabello corto"
  for (const k of ["corto", "medio", "largo"]) {
    P.balayage[k] = num(d.balayage && d.balayage[k], P.balayage[k]);
    P.tratamiento[k] = num(d.tratamiento && d.tratamiento[k], P.tratamiento[k]);
    P.balayageB[k] = num(d.balayageB && d.balayageB[k], P.balayageB[k]);
  }
  return P;
}

// ---------- REGLAS DEL DÍA ----------
// · Balayage: 1 por día, en su horario (8:30). Nunca el mismo día que un alisado.
// · Día de balayage: solo 1 cita más, de tinte o tratamiento, a la misma hora del balayage.
// · Los demás días: alisado, tinte y tratamiento comparten los turnos (8:30, 9:30, 11:00, 13:00).
//   Si un horario se ocupa con un servicio, ya no se puede reservar otro en ese horario.
function reglaDelDia(citas, serv, hora, h) {
  const bal = citas.find((c) => c.serv === "balayage");
  const esExtra = (s) => s === "tinte" || s === "tratamiento";
  if (serv === "balayage") {
    if (bal) return "Ya hay un balayage ese día";
    if (!h.balayage.includes(hora)) return "Horario no disponible";
    const otras = citas.filter((c) => c.serv !== "balayage");
    if (otras.some((c) => c.serv === "alisado")) return "Ese día es de alisados: no se agenda balayage";
    if (otras.length > 1 || (otras.length === 1 && otras[0].hora !== hora)) return "Ese día ya tiene otras citas";
    return null;
  }
  if (bal) {
    if (serv === "alisado") return "Ese día es de balayage: no se agendan alisados";
    if (citas.some((c) => esExtra(c.serv))) return "Ese día ya hay un tinte o tratamiento con el balayage";
    if (hora !== bal.hora) return "Horario no disponible";
    return null;
  }
  if (!h.turnos.includes(hora)) return "Horario no disponible";
  if (citas.some((c) => c.hora === hora)) return "Ese horario ya está ocupado";
  return null;
}

// ---------- Página y librerías ----------
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Fotos de resultados de cada servicio (carpeta img/ del repo)
app.use("/img", express.static(path.join(__dirname, "img"), { maxAge: "7d" }));
const NM = path.join(__dirname, "node_modules");
app.get("/vendor/jspdf.js", (req, res) => res.sendFile(path.join(NM, "jspdf", "dist", "jspdf.umd.min.js")));
app.get("/vendor/autotable.js", (req, res) => res.sendFile(path.join(NM, "jspdf-autotable", "dist", "jspdf.plugin.autotable.min.js")));

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  await new Promise((r) => setTimeout(r, 400)); // frena intentos repetidos
  res.json({ ok: (req.body && req.body.password) === ADMIN_PASSWORD });
});

// ---------- Importar clientas en lote (administradora) ----------
app.post("/api/clientes/import", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 2000) : [];
  let ok = 0;
  try {
    for (const it of items) {
      const c = limpiarCliente(it);
      if (!c) continue;
      await pool.query(
        `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
         ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || jsonb_build_object('nombre', $3::text, 'tel', $4::text), updated = now()`,
        ["c" + c.wa, c, c.nombre, c.tel]
      );
      ok++;
    }
    res.json({ ok: true, cargadas: ok });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Listar una colección ----------
// turnos: por defecto desde hace 60 días. La administradora puede pedir un rango: ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
app.get("/api/:coll", async (req, res) => {
  if (!checkParams(req, res)) return;
  const coll = req.params.coll;
  try {
    let rows;
    if (coll === "turnos" && isAdmin(req) && FECHA_RE.test(req.query.desde || "") && FECHA_RE.test(req.query.hasta || "")) {
      ({ rows } = await pool.query(
        "SELECT id, data FROM docs WHERE coll = 'turnos' AND id >= $1 AND id < $2 ORDER BY id",
        [req.query.desde, req.query.hasta + "_z"]
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT id, data FROM docs WHERE coll = $1 AND (coll <> 'turnos' OR id >= $2) ORDER BY id",
        [coll, haceDias(60)]
      ));
    }
    res.json(rows.map((r) => ({ id: r.id, data: visible(coll, r.data, req) })));
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Leer un documento ----------
app.get("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  try {
    const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [req.params.coll, req.params.id]);
    if (!rows.length) return res.json({ exists: false, data: null });
    res.json({ exists: true, data: visible(req.params.coll, rows[0].data, req) });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Guardar un documento ----------
app.put("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  const d = req.body || {};
  try {
    if (coll === "dias") {
      if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
      const data = { cerrado: !!d.cerrado };
      for (const k of SKEYS) data[k] = d[k] !== false;
      await upsert(coll, id, data);
      return res.json({ ok: true });
    }

    if (coll === "config") {
      if (!isAdmin(req)) return res.status(403).json({ error: "solo administradora" });
      const data = {};
      if (id === "horarios") {
        for (const k of ["balayage", "turnos"]) {
          const lista = Array.isArray(d[k]) ? d[k].filter((h) => HORA_RE.test(h)) : [];
          data[k] = [...new Set(lista)].sort().slice(0, 20);
        }
      } else {
        const num = (v) => (typeof v === "number" && v >= 0 && v < 10000 ? Math.round(v * 100) / 100 : null);
        data.alisado = num(d.alisado); data.tinte = num(d.tinte); data.balayage = {}; data.balayageB = {}; data.tratamiento = {};
        for (const k of ["corto", "medio", "largo"]) {
          data.balayage[k] = num(d.balayage && d.balayage[k]);
          data.tratamiento[k] = num(d.tratamiento && d.tratamiento[k]);
          data.balayageB[k] = num(d.balayageB && d.balayageB[k]);
        }
        const todo = [data.alisado, data.tinte, ...Object.values(data.balayage), ...Object.values(data.balayageB), ...Object.values(data.tratamiento)];
        if (todo.some((v) => v === null)) return res.status(400).json({ error: "precio inválido" });
      }
      await upsert(coll, id, data);
      return res.json({ ok: true });
    }

    if (coll === "clientes") {
      const c = limpiarCliente(d);
      if (!c || "c" + c.wa !== id) return res.status(400).json({ error: "datos incompletos" });
      await pool.query(
        `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
         ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || $2, updated = now()`,
        [id, c]
      );
      return res.json({ ok: true });
    }

    // turnos: el id dice fecha, servicio y hora (ej. 2026-11-03_alisado_0830)
    if (!str(d.nombre, 80) || !str(d.tel, 40) || !str(d.uid, 60)) {
      return res.status(400).json({ error: "datos incompletos" });
    }
    const [fecha, serv, hhmm] = id.split("_");
    const hora = hhmm.slice(0, 2) + ":" + hhmm.slice(2);
    const data = {
      fecha, serv, hora,
      nombre: capNombre(d.nombre), tel: d.tel.trim(), wa: soloDigitos(d.wa, 20),
      lang: d.lang === "en" ? "en" : "es", uid: d.uid,
      estado: d.estado === "pendiente" ? "pendiente" : "confirmado", ts: Date.now(),
    };
    if (OPCIONES[serv]) {
      if (!OPCIONES[serv].tipos[d.trat] || !largosDe(serv, d.trat)[d.largo]) return res.status(400).json({ error: "falta el tipo o el largo del cabello" });
      data.trat = d.trat; data.largo = d.largo;
    }

    if (isAdmin(req)) {
      await upsert(coll, id, data);
    } else {
      // Clienta: solo puede reservar un horario que exista, esté libre y respete las reglas del día
      const h = await horariosActuales();
      const { rows: delDia } = await pool.query("SELECT data FROM docs WHERE coll = 'turnos' AND id LIKE $1", [fecha + "_%"]);
      const motivo = reglaDelDia(delDia.map((r) => r.data), serv, hora, h);
      if (motivo) return res.status(409).json({ error: motivo });
      data.estado = "confirmado";
      const r = await pool.query(
        "INSERT INTO docs (coll, id, data) VALUES ($1, $2, $3) ON CONFLICT (coll, id) DO NOTHING",
        [coll, id, data]
      );
      if (r.rowCount === 0) return res.status(409).json({ error: "horario ocupado" });
      avisarPorMail(data); // aviso a la administradora (no frena la reserva si falla)
    }
    await guardarClienteDeTurno(data);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Borrar ----------
app.delete("/api/:coll/:id", async (req, res) => {
  if (!checkParams(req, res)) return;
  const { coll, id } = req.params;
  try {
    if (!isAdmin(req)) {
      if (coll !== "turnos") return res.status(403).json({ error: "solo administradora" });
      const { rows } = await pool.query("SELECT data FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
      if (!rows.length) return res.json({ ok: true });
      if (rows[0].data.uid !== String(req.query.uid || "")) return res.status(403).json({ error: "no es tu cita" });
    }
    await pool.query("DELETE FROM docs WHERE coll = $1 AND id = $2", [coll, id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "error de base de datos" }); }
});

// ---------- Clientas ----------
function limpiarCliente(d) {
  d = d || {};
  const wa = soloDigitos(d.wa || d.tel, 16);
  if (!str(d.nombre, 80) || wa.length < 6) return null;
  const c = { nombre: capNombre(d.nombre), tel: str(d.tel, 40) ? d.tel.trim() : "+" + wa, wa };
  if (typeof d.notas === "string") c.notas = d.notas.trim().slice(0, 500);
  return c;
}

// Cada reserva suma (o actualiza) a la clienta en la base, sin pisar las notas
async function guardarClienteDeTurno(t) {
  if (!t.wa || t.wa.length < 6) return;
  try {
    await pool.query(
      `INSERT INTO docs (coll, id, data) VALUES ('clientes', $1, $2)
       ON CONFLICT (coll, id) DO UPDATE SET data = docs.data || jsonb_build_object('ultimo', $3::text), updated = now()`,
      ["c" + t.wa, { nombre: t.nombre, tel: t.tel, wa: t.wa, ultimo: t.fecha, origen: "reserva" }, t.fecha]
    );
  } catch (e) { console.error("No se pudo guardar la clienta:", e.message); }
}

// ---------- Aviso por mail de cada reserva nueva (Resend) ----------
// Variables en Railway: RESEND_API_KEY y AVISO_EMAIL (el mail con el que se creó la cuenta de Resend)
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const AVISO_EMAIL = (process.env.AVISO_EMAIL || "").trim().toLowerCase();
const AVISO_DESDE = process.env.AVISO_DESDE || "Katerin <onboarding@resend.dev>";
const DIAS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fechaLarga(f) {
  const [y, m, d] = f.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DIAS_ES[dt.getDay()]} ${d} de ${MESES_ES[m - 1]}`;
}
function hora12(h) {
  const [hh, mm] = h.split(":").map(Number);
  return `${(hh % 12) || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

async function avisarPorMail(t) {
  if (!RESEND_API_KEY || !AVISO_EMAIL) { console.log("Aviso por mail desactivado: falta RESEND_API_KEY o AVISO_EMAIL"); return; }
  let serv = (SERVICIOS[t.serv] || {}).nombre || t.serv;
  const op = OPCIONES[t.serv];
  if (op && op.tipos[t.trat]) {
    const g = largosDe(t.serv, t.trat)[t.largo];
    const precio = precioDe(await preciosActuales(), t.serv, t.trat, t.largo);
    serv = op.tipos[t.trat] + (g ? ` (${g[0]}, $${precio} USD)` : "");
  }
  const fecha = fechaLarga(t.fecha);
  const fila = (k, v) => `<tr><td style="padding:10px 0;color:#76666b;width:120px;vertical-align:top">${k}</td><td style="padding:10px 0;color:#2a2226;font-weight:600">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f8f1ec;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fffdfb;border-radius:18px;overflow:hidden;border:1px solid #eddcd4">
    <div style="background:#33262c;padding:22px 24px;color:#e4c58c;font-family:Georgia,serif;font-size:22px;font-style:italic">Katerin</div>
    <div style="padding:24px">
      <div style="font-size:18px;color:#2a2226;margin-bottom:6px">💖 ¡Nueva cita reservada!</div>
      <div style="color:#76666b;font-size:14px;margin-bottom:12px">Una clienta acaba de agendarse desde la página.</div>
      <table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #eddcd4">
        ${fila("Servicio", escHtml(serv))}
        ${fila("Clienta", escHtml(t.nombre))}
        ${fila("Fecha", escHtml(fecha))}
        ${fila("Hora", escHtml(hora12(t.hora)))}
        ${fila("Teléfono", escHtml(t.tel))}
      </table>
      ${t.wa ? `<a href="https://wa.me/${t.wa}" style="display:inline-block;margin-top:18px;background:#9c4a60;color:#fff;text-decoration:none;padding:12px 22px;border-radius:99px;font-weight:600">Escribirle por WhatsApp</a>` : ""}
    </div>
  </div></div>`;
  const text = `Nueva cita reservada\n\nServicio: ${serv}\nClienta: ${t.nombre}\nFecha: ${fecha}\nHora: ${hora12(t.hora)}\nTeléfono: ${t.tel}\n${t.wa ? "WhatsApp: https://wa.me/" + t.wa : ""}`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: AVISO_DESDE, to: [AVISO_EMAIL], subject: `Nueva cita: ${serv} · ${t.nombre} · ${fecha} ${hora12(t.hora)}`, html, text }),
    });
    if (!r.ok) console.error("Resend respondió", r.status, await r.text());
    else console.log("Aviso por mail enviado a", AVISO_EMAIL);
  } catch (e) { console.error("No se pudo enviar el aviso por mail:", e.message); }
}

// ---------- Ayudas ----------
function upsert(coll, id, data) {
  return pool.query(
    "INSERT INTO docs (coll, id, data, updated) VALUES ($1, $2, $3, now()) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated = now()",
    [coll, id, data]
  );
}

function haceDias(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS docs (
    coll text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    updated timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (coll, id)
  )`);
  app.listen(PORT, () => console.log("Citas de Katerin escuchando en el puerto " + PORT));
}

start().catch((e) => { console.error("No se pudo iniciar:", e); process.exit(1); });
