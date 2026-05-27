// ============================================================
// WAC Seguros — Backend CRM
// ============================================================
const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const helmet = require("helmet")
require("dotenv").config()
const axios = require("axios")
const nodemailer = require("nodemailer")
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const crypto = require("crypto")

let webpush = null
try {
  webpush = require("web-push")
} catch (e) {
  console.warn("web-push no instalado.")
}

const authenticateToken = require("./middleware/auth")

const app = express()
const PORT = process.env.PORT || 3002

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://wacseguros.tusventas.com.ar",
  "https://wacseguros.netlify.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
]

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*")
  } else {
    res.setHeader("Access-Control-Allow-Origin", origin)
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Company-ID")
  res.setHeader("Access-Control-Allow-Credentials", "true")
  res.setHeader("Access-Control-Max-Age", "86400")
  if (req.method === "OPTIONS") return res.status(204).end()
  next()
})

app.use(cors({ origin: true, methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","X-Company-ID"], credentials: true, optionsSuccessStatus: 204 }))
app.options("*", cors())
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// ── Telegram (notificaciones internas) ────────────────────────────────────────
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || ""
async function enviarMensajeTelegram(texto) {
  try {
    if (!process.env.TELEGRAM_TOKEN || !CHAT_ID) return
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text: texto, parse_mode: "HTML",
    })
  } catch (e) { /* silencioso */ }
}

// ── Push Notifications ────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:wacseguros@tusventas.com.ar", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

async function enviarPushNotification(user, payload) {
  if (!webpush) return false
  const subs = []
  if (user.pushSubscription?.endpoint) subs.push(user.pushSubscription)
  if (user.pushSubscriptions?.length) subs.push(...user.pushSubscriptions)
  if (!subs.length) return false
  const payloadObj = {
    title: payload.title || "WAC Seguros",
    body: payload.body || "Nueva notificación",
    icon: payload.icon || "/icons/icon-192x192.png",
    badge: "/icons/icon-72x72.png",
    url: payload.url || "/",
    tag: payload.tag || "wac-notif",
    requireInteraction: payload.requireInteraction || false,
    data: payload.data || {},
  }
  let sent = false
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payloadObj))
      sent = true
    } catch (e) { /* ignora errores individuales */ }
  }
  return sent
}

async function enviarPushAUsuarios(users, payload) {
  const results = await Promise.allSettled(users.map(u => enviarPushNotification(u, payload)))
  return results.filter(r => r.status === "fulfilled" && r.value).length
}

// ── WAC Seguros Email Branding ────────────────────────────────────────────────
const WAC_COLOR   = "#0f2149"   // navy oscuro del logo
const WAC_ACCENT  = "#1d4ed8"   // azul

const EMAIL_FROM = process.env.EMAIL_FROM || process.env.EMAIL_SMTP

let transporter = null
if (process.env.EMAIL_SMTP) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: parseInt(process.env.SMTP_PORT || "25"),
    secure: false,
    tls: { rejectUnauthorized: false },
  })
  console.log("✉️  Email transporter configurado")
} else {
  console.warn("EMAIL_SMTP no configurado — notificaciones por email desactivadas.")
}

function _emailBase(accentColor, bandContent, bodyContent) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>WAC Seguros</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.10);">
      <tr><td style="background:${WAC_COLOR};padding:28px 32px;text-align:center;">
        <p style="margin:0;color:#ffffff;font-size:28px;font-weight:900;letter-spacing:6px;font-family:'Georgia',serif;">WAC</p>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:10px;letter-spacing:4px;text-transform:uppercase;">SEGUROS</p>
      </td></tr>
      <tr><td style="background:${accentColor};padding:24px 32px;text-align:center;">${bandContent}</td></tr>
      <tr><td style="padding:36px 32px;color:#1e293b;">${bodyContent}</td></tr>
      <tr><td style="background:${WAC_COLOR};padding:24px 32px;text-align:center;">
        <p style="margin:0;color:#94a3b8;font-size:13px;">Comuníquese con nosotros para más información.</p>
        <p style="margin:16px 0 0;color:#475569;font-size:10px;">Este es un mensaje automático. Por favor no responda a este correo.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
}

function buildEmailTemplate(tipo, { nombreApellido, aseguradora, patente, ramo, datosRiesgo, diaVto, mesLabel }) {
  const esAutomotor = ["AUTOS","MOTOS","FLOTA_AUTOMOTOR"].includes(ramo)
  const filas = []
  if (aseguradora) filas.push(["Aseguradora", aseguradora])
  if (ramo) filas.push(["Ramo", ramo])
  if (esAutomotor && patente) filas.push(["Patente", patente])
  if (datosRiesgo) filas.push(["Descripción", datosRiesgo])
  const polizaBlock = filas.length
    ? `<div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:16px 20px;margin:0 0 24px;">
         <p style="margin:0 0 10px;font-size:11px;font-weight:bold;color:${WAC_COLOR};text-transform:uppercase;letter-spacing:1.5px;">Datos de su póliza</p>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           ${filas.map(([l,v])=>`<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px;">${l}</td><td style="padding:4px 0;color:#1e293b;font-weight:600;font-size:13px;">${v}</td></tr>`).join("")}
         </table></div>` : ""

  if (tipo === "proximo_vencer") return {
    subject: `Su seguro está PRÓXIMO A VENCER — WAC Seguros`,
    html: _emailBase("#b45309",
      `<p style="margin:0;color:#fde68a;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">⏰ AVISO IMPORTANTE</p>
       <p style="margin:10px 0 0;color:#ffffff;font-size:22px;font-weight:bold;">Su seguro está<br>PRÓXIMO A VENCER</p>`,
      `<p style="font-size:16px;margin:0 0 20px;">Estimado/a <strong>${nombreApellido}</strong>,</p>
       <p style="font-size:15px;margin:0 0 20px;line-height:1.7;color:#334155;">Le informamos que su póliza vence el día <strong style="color:#b45309;">${diaVto}</strong> de <strong>${mesLabel}</strong>.</p>
       ${polizaBlock}
       <p style="font-size:15px;margin:0 0 28px;line-height:1.7;color:#334155;">Para continuar con su cobertura sin interrupciones, le pedimos que realice el pago a la brevedad.</p>
       <div style="background:#fef3c7;border-left:4px solid #b45309;border-radius:0 6px 6px 0;padding:14px 18px;">
         <p style="margin:0;font-size:13px;color:#78350f;">💡 <strong>Recuerde:</strong> Circular sin seguro vigente puede traer consecuencias legales y económicas.</p>
       </div>`)
  }
  if (tipo === "vence_hoy") return {
    subject: `⚠️ Su seguro VENCE HOY — WAC Seguros`,
    html: _emailBase("#c2410c",
      `<p style="margin:0;color:#fed7aa;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">⚠️ AVISO URGENTE</p>
       <p style="margin:10px 0 0;color:#ffffff;font-size:22px;font-weight:bold;">Su seguro<br>VENCE HOY</p>`,
      `<p style="font-size:16px;margin:0 0 20px;">Estimado/a <strong>${nombreApellido}</strong>,</p>
       <p style="font-size:15px;margin:0 0 20px;line-height:1.7;color:#334155;">Hoy, día <strong style="color:#c2410c;">${diaVto} de ${mesLabel}</strong>, vence su póliza de seguro.</p>
       ${polizaBlock}
       <p style="font-size:15px;margin:0 0 28px;line-height:1.7;color:#334155;">Si ya realizó el pago, por favor envíenos el comprobante. Si aún no lo realizó, comuníquese con nosotros de inmediato.</p>
       <div style="background:#fff7ed;border-left:4px solid #c2410c;border-radius:0 6px 6px 0;padding:14px 18px;">
         <p style="margin:0;font-size:13px;color:#7c2d12;">⚠️ <strong>Importante:</strong> Si el pago no se acredita hoy, su cobertura podría quedar suspendida.</p>
       </div>`)
  }
  if (tipo === "vencido") return {
    subject: `🚨 URGENTE: Su seguro está VENCIDO — WAC Seguros`,
    html: _emailBase("#991b1b",
      `<p style="display:inline-block;background:#fca5a5;color:#7f1d1d;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:4px 14px;border-radius:20px;margin:0 0 12px;">SIN COBERTURA — REGULARICE YA</p>
       <p style="margin:0;color:#ffffff;font-size:22px;font-weight:bold;">Su seguro está VENCIDO</p>`,
      `<p style="font-size:16px;margin:0 0 20px;">Estimado/a <strong>${nombreApellido}</strong>,</p>
       <p style="font-size:15px;margin:0 0 20px;line-height:1.7;color:#334155;">Le informamos que su póliza <strong style="color:#991b1b;">se encuentra vencida</strong> desde el día <strong>${diaVto} de ${mesLabel}</strong>.</p>
       ${polizaBlock}
       <p style="font-size:15px;margin:0 0 28px;line-height:1.7;color:#334155;">Actualmente <strong>no cuenta con cobertura</strong>. Comuníquese con nosotros <strong>hoy mismo</strong>.</p>
       <div style="background:#fef2f2;border-left:4px solid #991b1b;border-radius:0 6px 6px 0;padding:14px 18px;">
         <p style="margin:0;font-size:13px;color:#7f1d1d;">🚨 <strong>Atención:</strong> Circular sin seguro es una infracción grave.</p>
       </div>`)
  }
  return null
}

function buildEmailMasivoTemplate({ asunto, mensaje, imagenCid }) {
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  const mensajeHtml = esc(mensaje).replace(/\n/g,"<br>")
  const imagenBlock = imagenCid ? `<div style="text-align:center;margin:0 0 28px;"><img src="cid:${imagenCid}" alt="Imagen" style="max-width:100%;border-radius:8px;display:block;margin:0 auto;" /></div>` : ""
  return {
    subject: asunto,
    html: _emailBase(WAC_ACCENT,
      `<p style="margin:0;color:#bfdbfe;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">📨 COMUNICADO</p>
       <p style="margin:10px 0 0;color:#ffffff;font-size:22px;font-weight:bold;">${esc(asunto)}</p>`,
      `${imagenBlock}<div style="font-size:15px;line-height:1.8;color:#334155;margin:0 0 28px;">${mensajeHtml}</div>
       <div style="background:#f1f5f9;border-left:4px solid ${WAC_COLOR};border-radius:0 6px 6px 0;padding:14px 18px;">
         <p style="margin:0;font-size:13px;color:#475569;">📞 Para consultas comuníquese con nosotros por WhatsApp o visítenos en nuestra oficina.</p>
       </div>`)
  }
}

async function enviarEmailAnuncio(notification, recipients) {
  if (!transporter) return 0
  const typeLabels = { info:"Información", warning:"Aviso Importante", success:"Buenas Noticias", meeting:"Reunión", material:"Nuevo Material", document:"Documento", announcement:"Anuncio", training:"Capacitación" }
  const validRecipients = recipients.filter(r => r.email)
  let emailsSent = 0
  const baseUrl = process.env.BACKEND_URL || "https://vps-5905394-x.dattaweb.com"

  let attachmentsHtml = ""
  let meetingHtml = ""
  if (notification.type === "meeting" && notification.meetingInfo) {
    const mi = notification.meetingInfo
    meetingHtml = `<div style="background:#dbeafe;padding:15px;border-radius:8px;margin:20px 0;">
      <h4 style="margin:0 0 10px;color:#1e40af;">Detalles de la Reunión</h4>
      ${mi.date ? `<p style="margin:5px 0;"><strong>Fecha:</strong> ${mi.date}</p>` : ""}
      ${mi.time ? `<p style="margin:5px 0;"><strong>Hora:</strong> ${mi.time}</p>` : ""}
      ${mi.location ? `<p style="margin:5px 0;"><strong>Lugar:</strong> ${mi.location}</p>` : ""}
      ${mi.link ? `<p style="margin:10px 0;"><a href="${mi.link}" style="color:#3b82f6;font-weight:bold;">Unirse a la reunión</a></p>` : ""}
    </div>`
  }
  if (notification.attachments?.length) {
    const items = notification.attachments.map(att => {
      const url = att.url?.startsWith("http") ? att.url : `${baseUrl}${att.url}`
      const isImg = att.type?.startsWith("image/")
      const name = att.originalName || att.filename || "archivo"
      return isImg
        ? `<div style="margin-bottom:15px;text-align:center;"><img src="${url}" alt="${name}" style="max-width:100%;max-height:300px;border-radius:8px;" /></div>`
        : `<div style="margin-bottom:10px;padding:12px;background:#e5e7eb;border-radius:6px;"><a href="${url}" style="color:#3b82f6;font-weight:500;">📎 ${name}</a></div>`
    }).join("")
    attachmentsHtml = `<div style="background:#fff;padding:20px;border-radius:8px;margin:20px 0;border:1px solid #e5e7eb;"><h4 style="margin:0 0 15px;">Archivos Adjuntos</h4>${items}</div>`
  }

  const emailBody = `${attachmentsHtml}
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin:0 0 16px;">
      <p style="margin:0;font-size:14px;color:#374151;white-space:pre-wrap;line-height:1.7;">${notification.message}</p>
    </div>${meetingHtml}`
  const emailHtml = _emailBase(WAC_ACCENT,
    `<p style="margin:0;color:#bfdbfe;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${typeLabels[notification.type] || "📢 Anuncio"}</p>
     <p style="margin:10px 0 0;color:#ffffff;font-size:20px;font-weight:bold;">${notification.title}</p>`,
    emailBody)

  const BATCH = 10
  for (let i = 0; i < validRecipients.length; i += BATCH) {
    const batch = validRecipients.slice(i, i + BATCH)
    const results = await Promise.allSettled(batch.map(r =>
      transporter.sendMail({ from: `"WAC Seguros" <${EMAIL_FROM}>`, to: r.email, subject: notification.title, html: emailHtml })
    ))
    results.forEach((r,idx) => {
      if (r.status === "fulfilled") emailsSent++
      else console.error(`[Anuncio] Error a ${batch[idx].email}: ${r.reason?.message}`)
    })
    if (i + BATCH < validRecipients.length) await new Promise(r => setTimeout(r, 50))
  }
  return emailsSent
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.memoryStorage()
const upload = multer({ storage })

// ── Error handler ─────────────────────────────────────────────────────────────
const handleError = (res, error, message = "Server error") => {
  console.error(`${message}:`, error)
  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map(e => e.message)
    return res.status(400).json({ success: false, error: "Validation failed", message: errors.join(", "), details: errors })
  }
  if (error.name === "CastError") {
    return res.status(400).json({ success: false, error: `Invalid ${error.path}: ${error.value}` })
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0]
    return res.status(400).json({ success: false, error: `${field} already exists`, code: "DUPLICATE_FIELD" })
  }
  res.status(500).json({ success: false, error: message, message: error.message || message })
}

// ── MongoDB (local VPS) ───────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/wacseguros", {
      useNewUrlParser: true, useUnifiedTopology: true, family: 4,
    })
    console.log(`✅ MongoDB conectado: ${conn.connection.host} — DB: ${conn.connection.name}`)
    mongoose.connection.on("error", err => console.error("❌ MongoDB error:", err))
    mongoose.connection.on("disconnected", () => console.log("🔌 MongoDB desconectado"))
  } catch (error) {
    console.error("❌ Error conectando MongoDB:", error.message)
    process.exit(1)
  }
}
connectDB()

// ── Schemas ───────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6 },
  phone: { type: String, required: true, trim: true },
  location: { type: String, required: true, trim: true },
  role: { type: String, enum: ["admin", "admin_seguros", "support", "seller"], default: "seller" },
  isActive: { type: Boolean, default: true },
  lastActivity: { type: Date, default: null },
  sessionStart: { type: Date, default: null },
  isOnline: { type: Boolean, default: false },
  pushSubscription: { endpoint: String, keys: { p256dh: String, auth: String } },
  pushSubscriptions: [{
    _id: false, endpoint: String, keys: { p256dh: String, auth: String },
    deviceInfo: { type: String, default: "Unknown" },
    createdAt: { type: Date, default: Date.now }, lastUsed: { type: Date, default: Date.now },
  }],
  refreshTokens: [{ _id: false, token: String, createdAt: { type: Date, default: Date.now } }],
}, { timestamps: true })

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  message: { type: String, required: true, trim: true },
  type: { type: String, enum: ["info","meeting","material","warning","success","document","announcement","training"], default: "info" },
  priority: { type: String, enum: ["low","medium","high","urgent"], default: "medium" },
  recipientType: { type: String, enum: ["all","selected"], default: "all" },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  attachments: { type: mongoose.Schema.Types.Mixed, default: [] },
  meetingInfo: { date: String, time: String, duration: Number, platform: String, link: String, location: String, description: String },
  readBy: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, readAt: { type: Date, default: Date.now } }],
  isActive: { type: Boolean, default: true },
  emailsSent: { type: Boolean, default: false },
  emailSentCount: { type: Number, default: 0 },
}, { timestamps: true })

const chatRoomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ["group","private"], default: "group" },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
  lastActivity: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

const messageSchema = new mongoose.Schema({
  chatRoom: { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom", required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, default: "" },
  type: { type: String, enum: ["text","image","file","system"], default: "text" },
  attachments: [{ filename: String, originalName: String, mimetype: String, size: Number, path: String }],
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
}, { timestamps: true })

// WAC Seguros — Aseguradoras y Ramos
const ASEGURADORAS = [
  "LA_CAJA","MERCANTIL_ANDINA","SAN_CRISTOBAL","SANCOR","ALLIANZ",
  "ZURICH","GALICIA","LA_PERSEVERANCIA","ATM","BERKLEY",
  "RIVADAVIA","MAPFRE","NACION","INTEGRITY","PROVIDENCIA","PROF","OTRA"
]
const RAMOS = [
  "AUTOS","MOTOS","HOGAR","INCENDIO","INT_COMERCIO",
  "ART","ACC_PERSONALES","VIDA","RESP_CIVIL","OBJ_ESPECIFICOS",
  "FLOTA_AUTOMOTOR","OTRO"
]

const polizaSchema = new mongoose.Schema({
  fechaInicVig: { type: Date },
  medioDePago: { type: String, enum: ["TARJ_CRED","CBU","EFECTIVO","CUPON","OTRO"], default: "EFECTIVO" },
  estado: { type: String, enum: ["VIGENTE","ANULADA","PENDIENTE_CLIENTE"], default: "VIGENTE" },
  motivoAnulacion: { type: String },
  fechaAnulacion: { type: Date },
  patente: { type: String },
  aseguradora: { type: String, enum: ASEGURADORAS },
  ramo: { type: String, enum: RAMOS },
  tipoCobertura: { type: String },
  nombreApellido: { type: String, required: true },
  dni: { type: String },
  fechaNacimiento: { type: Date },
  celular: { type: String },
  email: { type: String },
  domicilio: { type: String },
  localidad: { type: String },
  cp: { type: String },
  datosRiesgo: { type: String },
  chasis: { type: String },
  motor: { type: String },
  gnc: { type: Boolean, default: false },
  numPoliza: { type: String },
  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const siniestroSchema = new mongoose.Schema({
  numPoliza: { type: String },
  polizaId: { type: mongoose.Schema.Types.ObjectId, ref: "Poliza" },
  bienAsegurado: { type: String },
  fechaOcurrencia: { type: Date },
  tipoSiniestro: { type: String, enum: ["ROBO_TOTAL","ROBO_PARCIAL","DAÑO_TOTAL","CHOQUE_ACCIDENTE","CRISTALES","INCENDIO","GRANIZO","OTRO"] },
  compania: { type: String },
  asegurado: { type: String, required: true },
  denunciaAdministrativa: { type: String, enum: ["REALIZADA","PENDIENTE"], default: "PENDIENTE" },
  numeroSiniestro: { type: String },
  estado: { type: String, enum: ["EN_TRAMITE","FINALIZADO","RECHAZADO"], default: "EN_TRAMITE" },
  observaciones: { type: String },
  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const MES_LABELS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

const cobranzaEfectivoSchema = new mongoose.Schema({
  polizaId: { type: mongoose.Schema.Types.ObjectId, ref: "Poliza" },
  sucursal: { type: String },
  diaVto: { type: Number },
  nombreApellido: { type: String, required: true },
  email: { type: String },
  ramo: { type: String },
  whatsapp: { type: String },
  aseguradora: { type: String },
  patente: { type: String },
  datosRiesgo: { type: String },
  pagos: [{
    mes: { type: String },
    mesLabel: { type: String },
    estado: { type: String, enum: ["COBRADA","CUPON_ENVIADO","CUOTA_VENCIDA","COMPROMISO_PAGO","NO_CORRESPONDE","ANULADA","PENDIENTE"], default: "PENDIENTE" },
    cobradoPor: { type: String },
    fechaCobro: { type: Date },
  }],
  emailNotificaciones: [{
    tipo: { type: String, enum: ["proximo_vencer","vence_hoy","vencido"] },
    mes: { type: String },
    enviadoEn: { type: Date },
    estado: { type: String, enum: ["enviado","error"], default: "enviado" },
    errorMsg: { type: String },
  }],
  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const seguimientoSchema = new mongoose.Schema({
  patente: { type: String },
  nombre: { type: String },
  apellido: { type: String },
  dni: { type: String },
  email: { type: String },
  celular: { type: String },
  estado: { type: String, enum: ["NUEVO","CONTACTADO","COTIZANDO","EMITIDO","RECHAZADO"], default: "NUEVO" },
  observaciones: { type: String },
  fechaContacto: { type: Date },
  creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true })

// ── Models ────────────────────────────────────────────────────────────────────
const User             = mongoose.model("User", userSchema)
const Notification     = mongoose.model("Notification", notificationSchema)
const ChatRoom         = mongoose.model("ChatRoom", chatRoomSchema)
const Message          = mongoose.model("Message", messageSchema)
const Poliza           = mongoose.model("Poliza", polizaSchema)
const Siniestro        = mongoose.model("Siniestro", siniestroSchema)
const CobranzaEfectivo = mongoose.model("CobranzaEfectivo", cobranzaEfectivoSchema)
const Seguimiento      = mongoose.model("Seguimiento", seguimientoSchema)

// ── Middleware de roles ───────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (!["admin","admin_seguros"].includes(req.user.role)) {
    return res.status(403).json({ success: false, error: "Acceso denegado. Se requiere rol admin." })
  }
  next()
}
const requireAdminOrSupport = (req, res, next) => {
  if (!["admin","admin_seguros","support"].includes(req.user.role)) {
    return res.status(403).json({ success: false, error: "Acceso denegado." })
  }
  next()
}

// ── Uploads ───────────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, "uploads")
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use("/uploads", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  next()
}, express.static(uploadsDir))

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", async (req, res) => {
  try {
    const dbStatus = ["disconnected","connected","connecting","disconnecting"][mongoose.connection.readyState] || "unknown"
    const [users, polizas, siniestros, notifs] = await Promise.all([
      User.countDocuments(), Poliza.countDocuments(), Siniestro.countDocuments(), Notification.countDocuments()
    ])
    res.json({ success: true, status: "OK", timestamp: new Date().toISOString(), uptime: process.uptime(),
      db: { status: dbStatus, collections: { users, polizas, siniestros, notifs } }
    })
  } catch (e) {
    res.status(500).json({ success: false, status: "ERROR", error: e.message })
  }
})

// ============================================================
// AUTH
// ============================================================
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone, location } = req.body
    if (!name || !email || !password || !phone || !location)
      return res.status(400).json({ success: false, error: "Todos los campos son requeridos" })
    if (password.length < 6)
      return res.status(400).json({ success: false, error: "La contraseña debe tener al menos 6 caracteres" })
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, error: "El email ya está en uso" })

    const user = new User({ name, email, password: await bcrypt.hash(password, 12), phone, location })
    await user.save()

    const token = jwt.sign({ userId: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "1h" })
    res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, role: user.role } })
    setImmediate(() => enviarMensajeTelegram(`<b>Nuevo registro WAC Seguros</b>\nNombre: ${name}\nEmail: ${email}`))
  } catch (e) { handleError(res, e, "Registration failed") }
})

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ success: false, error: "Email y contraseña requeridos" })

    const user = await User.findOne({ email })
    if (!user || !user.isActive) return res.status(400).json({ success: false, error: "Credenciales inválidas" })
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ success: false, error: "Credenciales inválidas" })

    const token = jwt.sign({ userId: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "1h" })
    const refreshToken = crypto.randomBytes(40).toString("hex")
    const now = new Date()
    let tokens = user.refreshTokens || []
    tokens.push({ token: refreshToken, createdAt: now })
    if (tokens.length > 5) tokens = tokens.slice(-5)
    await User.findByIdAndUpdate(user._id, { isOnline: true, sessionStart: now, lastActivity: now, refreshTokens: tokens })

    res.cookie("rt", refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", maxAge: 30*24*60*60*1000, path: "/" })
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, location: user.location, role: user.role } })
  } catch (e) { handleError(res, e, "Login failed") }
})

app.get("/api/users/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password")
    if (!user) return res.status(404).json({ success: false, error: "Usuario no encontrado" })
    res.json({ success: true, user })
  } catch (e) { handleError(res, e, "Failed to fetch profile") }
})

app.post("/api/users/heartbeat", authenticateToken, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.userId, { lastActivity: new Date(), isOnline: true })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ success: false }) }
})

app.post("/api/auth/logout", authenticateToken, async (req, res) => {
  try {
    const cookies = req.headers.cookie || ""
    const rtCookie = cookies.split(";").find(c => c.trim().startsWith("rt="))
    const refreshToken = rtCookie ? rtCookie.trim().split("=").slice(1).join("=") : null
    const update = { isOnline: false, lastActivity: new Date() }
    if (refreshToken) {
      await User.updateOne({ _id: req.user.userId }, { $pull: { refreshTokens: { token: refreshToken } }, ...update })
    } else {
      await User.findByIdAndUpdate(req.user.userId, update)
    }
    res.clearCookie("rt", { path: "/", httpOnly: true, sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", secure: process.env.NODE_ENV === "production" })
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Logout failed") }
})

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const cookies = req.headers.cookie || ""
    const rtCookie = cookies.split(";").find(c => c.trim().startsWith("rt="))
    const refreshToken = rtCookie ? rtCookie.trim().split("=").slice(1).join("=") : null
    if (!refreshToken) return res.status(401).json({ success: false, error: "No refresh token" })

    const user = await User.findOne({ "refreshTokens.token": refreshToken, isActive: true })
    if (!user) return res.status(401).json({ success: false, error: "Refresh token inválido" })

    const tokenDoc = user.refreshTokens.find(t => t.token === refreshToken)
    if (!tokenDoc || Date.now() - new Date(tokenDoc.createdAt).getTime() > 30*24*60*60*1000) {
      return res.status(401).json({ success: false, error: "Refresh token expirado" })
    }

    const newRefreshToken = crypto.randomBytes(40).toString("hex")
    await User.updateOne({ _id: user._id, "refreshTokens.token": refreshToken }, { $set: { "refreshTokens.$.token": newRefreshToken, "refreshTokens.$.createdAt": new Date() } })

    const newToken = jwt.sign({ userId: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "1h" })
    res.cookie("rt", newRefreshToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", maxAge: 30*24*60*60*1000, path: "/" })
    res.json({ success: true, token: newToken, user: { id: user._id, name: user.name, email: user.email, role: user.role } })
  } catch (e) { handleError(res, e, "Token refresh failed") }
})

app.put("/api/users/profile", authenticateToken, async (req, res) => {
  try {
    const { name, phone, location, password } = req.body
    const update = {}
    if (name) update.name = name
    if (phone) update.phone = phone
    if (location) update.location = location
    if (password && password.length >= 6) update.password = await bcrypt.hash(password, 12)
    const user = await User.findByIdAndUpdate(req.user.userId, update, { new: true }).select("-password")
    res.json({ success: true, user })
  } catch (e) { handleError(res, e, "Failed to update profile") }
})

// ============================================================
// PUSH SUBSCRIPTIONS
// ============================================================
app.post("/api/users/push-subscription", authenticateToken, async (req, res) => {
  try {
    const { subscription, deviceInfo } = req.body
    if (!subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ success: false, error: "Suscripción inválida" })
    }
    const device = deviceInfo || req.headers["user-agent"] || "Unknown"
    const user = await User.findById(req.user.userId)
    if (!user) return res.status(404).json({ success: false, error: "Usuario no encontrado" })

    const newSub = { endpoint: subscription.endpoint, keys: subscription.keys, deviceInfo: device, createdAt: new Date(), lastUsed: new Date() }
    let subs = user.pushSubscriptions || []
    const existingIdx = subs.findIndex(s => s.endpoint === subscription.endpoint)
    if (existingIdx >= 0) subs[existingIdx] = newSub
    else {
      subs.push(newSub)
      if (subs.length > 10) subs = subs.slice(-10)
    }
    await User.findByIdAndUpdate(user._id, { pushSubscription: subscription, pushSubscriptions: subs })
    res.json({ success: true, message: "Suscripción push guardada" })
  } catch (e) { handleError(res, e, "Failed to save push subscription") }
})

app.delete("/api/users/push-subscription", authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body
    if (endpoint) {
      await User.updateOne({ _id: req.user.userId }, { $pull: { pushSubscriptions: { endpoint } } })
    } else {
      await User.findByIdAndUpdate(req.user.userId, { pushSubscription: {}, pushSubscriptions: [] })
    }
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Failed to remove push subscription") }
})

// ============================================================
// ADMIN — USUARIOS
// ============================================================
app.get("/api/admin/online-users", authenticateToken, async (req, res) => {
  try {
    const threshold = new Date(Date.now() - 2 * 60 * 1000)
    const onlineUsers = await User.find({ lastActivity: { $gte: threshold }, isActive: true }).select("name email role lastActivity isOnline")
    res.json({ success: true, onlineUsers, count: onlineUsers.length })
  } catch (e) { handleError(res, e, "Failed to fetch online users") }
})

app.get("/api/admin/users", authenticateToken, requireAdminOrSupport, async (req, res) => {
  try {
    const { page = 1, limit = 200, isActive } = req.query
    const query = {}
    if (isActive !== undefined) query.isActive = isActive === "true"
    const users = await User.find(query).select("-password").sort({ createdAt: -1 }).limit(Number(limit)).skip((Number(page)-1)*Number(limit))
    const total = await User.countDocuments(query)
    res.json({ success: true, users, pagination: { total, currentPage: Number(page), totalPages: Math.ceil(total/Number(limit)) } })
  } catch (e) { handleError(res, e, "Failed to fetch users") }
})

app.post("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, phone, location, role } = req.body
    if (!name || !email || !password || !phone || !location)
      return res.status(400).json({ success: false, error: "Todos los campos son requeridos" })
    if (password.length < 6)
      return res.status(400).json({ success: false, error: "La contraseña debe tener al menos 6 caracteres" })
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, error: "El email ya está en uso" })

    const user = new User({ name, email, password: await bcrypt.hash(password, 12), phone, location, role: role || "seller" })
    await user.save()
    res.status(201).json({ success: true, user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, location: user.location, role: user.role, isActive: user.isActive } })
  } catch (e) { handleError(res, e, "Failed to create user") }
})

app.put("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, location, role, isActive, password } = req.body
    const update = {}
    if (name) update.name = name
    if (email) update.email = email
    if (phone) update.phone = phone
    if (location) update.location = location
    if (role) update.role = role
    if (isActive !== undefined) update.isActive = isActive
    if (password && password.length >= 6) update.password = await bcrypt.hash(password, 12)
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).select("-password")
    if (!user) return res.status(404).json({ success: false, error: "Usuario no encontrado" })
    res.json({ success: true, user })
  } catch (e) { handleError(res, e, "Failed to update user") }
})

app.delete("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id)
    if (!user) return res.status(404).json({ success: false, error: "Usuario no encontrado" })
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Failed to delete user") }
})

// ============================================================
// NOTIFICACIONES (Anuncios internos)
// ============================================================
app.get("/api/notifications", authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly } = req.query
    const userId = req.user.userId
    const query = {
      $or: [{ recipients: userId }, { recipients: { $size: 0 } }],
      isActive: true,
    }
    if (unreadOnly === "true") query["readBy.userId"] = { $ne: userId }
    const notifications = await Notification.find(query).populate("createdBy", "name role").sort({ createdAt: -1 }).limit(Number(limit)).skip((Number(page)-1)*Number(limit))
    const total = await Notification.countDocuments(query)
    const unreadCount = await Notification.countDocuments({ ...query, "readBy.userId": { $ne: userId } })
    res.json({ success: true, notifications, unreadCount, pagination: { total, currentPage: Number(page), totalPages: Math.ceil(total/Number(limit)) } })
  } catch (e) { handleError(res, e, "Failed to fetch notifications") }
})

app.get("/api/notifications/unread-count", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId
    const count = await Notification.countDocuments({
      $or: [{ recipients: userId }, { recipients: { $size: 0 } }],
      isActive: true, "readBy.userId": { $ne: userId },
    })
    res.json({ success: true, count })
  } catch (e) { handleError(res, e, "Failed to fetch unread count") }
})

app.post("/api/notifications", authenticateToken, requireAdmin, upload.array("attachments", 5), async (req, res) => {
  try {
    const { title, message, type, priority, recipientType, recipients, meetingInfo } = req.body
    if (!title || !message) return res.status(400).json({ success: false, error: "Título y mensaje requeridos" })

    let parsedRecipients = []
    if (recipients) try { parsedRecipients = typeof recipients === "string" ? JSON.parse(recipients) : recipients } catch(e){}
    let parsedMeetingInfo = null
    if (meetingInfo) try { parsedMeetingInfo = typeof meetingInfo === "string" ? JSON.parse(meetingInfo) : meetingInfo } catch(e){}

    let attachments = []
    if (req.files?.length) {
      const dir = path.join(__dirname, "uploads", "notifications")
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      attachments = await Promise.all(req.files.map(async (file, i) => {
        const name = `${Date.now()}_${i}_${file.originalname}`
        fs.writeFileSync(path.join(dir, name), file.buffer)
        return { originalName: file.originalname, filename: file.originalname, url: `/uploads/notifications/${name}`, type: file.mimetype, size: file.size || 0 }
      }))
    }

    const notification = new Notification({
      title, message, type: type || "info", priority: priority || "medium",
      recipientType: recipientType || "all",
      recipients: recipientType === "selected" ? parsedRecipients : [],
      meetingInfo: parsedMeetingInfo, attachments, createdBy: req.user.userId, readBy: [],
    })
    await notification.save()

    let emailRecipients = []
    if (recipientType === "all") {
      emailRecipients = await User.find({ isActive: true })
    } else if (parsedRecipients.length) {
      emailRecipients = await User.find({ _id: { $in: parsedRecipients }, isActive: true })
    }

    await notification.populate("createdBy", "name")
    res.json({ success: true, notification, message: "Anuncio creado. Los emails se envían en segundo plano." })

    setImmediate(async () => {
      try {
        const sent = await enviarEmailAnuncio(notification, emailRecipients)
        await Notification.findByIdAndUpdate(notification._id, { emailsSent: sent > 0, emailSentCount: sent })
      } catch(e) { console.error("[Anuncio] Error emails:", e.message) }
      try {
        if (emailRecipients.length) {
          const pushR = await User.find({ _id: { $in: emailRecipients.map(u => u._id) }, $or: [{ "pushSubscription.endpoint": { $exists: true, $ne: "" } }, { "pushSubscriptions.0": { $exists: true } }] })
          if (pushR.length) await enviarPushAUsuarios(pushR, { title, body: message.slice(0,100), url: `/notifications/view?id=${notification._id}`, tag: `announcement-${notification._id}` })
        }
      } catch(e) { console.error("[Anuncio] Error push:", e.message) }
    })
  } catch (e) { handleError(res, e, "Failed to create notification") }
})

app.put("/api/notifications/mark-all-read", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId
    const notifs = await Notification.find({ $or: [{ recipients: userId }, { recipients: { $size: 0 } }], isActive: true, "readBy.userId": { $ne: userId } })
    for (const n of notifs) {
      n.readBy.push({ userId, readAt: new Date() })
      await n.save()
    }
    res.json({ success: true, markedCount: notifs.length })
  } catch (e) { handleError(res, e, "Failed to mark all as read") }
})

app.put("/api/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id)
    if (!notification) return res.status(404).json({ success: false, error: "Notificación no encontrada" })
    const alreadyRead = notification.readBy.some(r => r.userId.toString() === req.user.userId)
    if (!alreadyRead) { notification.readBy.push({ userId: req.user.userId, readAt: new Date() }); await notification.save() }
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Failed to mark as read") }
})

app.get("/api/admin/announcements", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const notifications = await Notification.find({ isActive: true }).populate("createdBy","name").sort({ createdAt: -1 }).limit(50)
    res.json({ success: true, notifications })
  } catch (e) { handleError(res, e, "Failed to get announcements") }
})

app.delete("/api/notifications/bulk", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids?.length) return res.status(400).json({ success: false, error: "IDs requeridos" })
    const result = await Notification.deleteMany({ _id: { $in: ids } })
    res.json({ success: true, deleted: result.deletedCount })
  } catch (e) { handleError(res, e, "Failed to bulk delete") }
})

app.delete("/api/notifications/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const n = await Notification.findByIdAndDelete(req.params.id)
    if (!n) return res.status(404).json({ success: false, error: "Notificación no encontrada" })
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Failed to delete notification") }
})

// ============================================================
// CHAT
// ============================================================
app.get("/api/chat/rooms", authenticateToken, async (req, res) => {
  try {
    const rooms = await ChatRoom.find({ participants: req.user.userId, isActive: true }).populate("participants","name role").populate("lastMessage").populate("createdBy","name role").sort({ lastActivity: -1 })
    res.json({ success: true, rooms })
  } catch (e) { handleError(res, e, "Failed to fetch chat rooms") }
})

app.post("/api/chat/rooms", authenticateToken, async (req, res) => {
  try {
    const { name, type, participants } = req.body
    if (!name || !type) return res.status(400).json({ success: false, error: "Nombre y tipo requeridos" })
    const roomParticipants = [...new Set([req.user.userId, ...(participants || [])])]
    const chatRoom = new ChatRoom({ name, type, participants: roomParticipants, createdBy: req.user.userId })
    await chatRoom.save()
    const populated = await ChatRoom.findById(chatRoom._id).populate("participants","name role").populate("createdBy","name role")
    res.status(201).json({ success: true, room: populated })
  } catch (e) { handleError(res, e, "Failed to create chat room") }
})

app.get("/api/chat/rooms/:roomId/messages", authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query
    const room = await ChatRoom.findById(req.params.roomId)
    if (!room || !room.participants.includes(req.user.userId)) return res.status(403).json({ success: false, error: "Acceso denegado" })
    const messages = await Message.find({ chatRoom: req.params.roomId }).populate("sender","name role").sort({ createdAt: -1 }).limit(Number(limit)).skip((Number(page)-1)*Number(limit))
    const total = await Message.countDocuments({ chatRoom: req.params.roomId })
    res.json({ success: true, messages: messages.reverse(), pagination: { total, currentPage: Number(page), totalPages: Math.ceil(total/Number(limit)) } })
  } catch (e) { handleError(res, e, "Failed to fetch messages") }
})

app.post("/api/chat/rooms/:roomId/messages", authenticateToken, upload.array("attachments", 3), async (req, res) => {
  try {
    const { content, type } = req.body
    if (!content && !req.files?.length) return res.status(400).json({ success: false, error: "Contenido requerido" })
    const room = await ChatRoom.findById(req.params.roomId)
    if (!room || !room.participants.includes(req.user.userId)) return res.status(403).json({ success: false, error: "Acceso denegado" })

    const attachments = req.files?.map(f => ({ filename: f.filename, originalName: f.originalname, mimetype: f.mimetype, size: f.size, path: f.path })) || []
    const message = new Message({ chatRoom: req.params.roomId, sender: req.user.userId, content: content || "", type: type || "text", attachments })
    await message.save()
    await ChatRoom.findByIdAndUpdate(req.params.roomId, { lastMessage: message._id, lastActivity: new Date() })
    const populated = await Message.findById(message._id).populate("sender","name role")
    res.status(201).json({ success: true, data: populated })

    setImmediate(async () => {
      try {
        const fullRoom = await ChatRoom.findById(req.params.roomId).populate("participants")
        const sender = await User.findById(req.user.userId).select("name")
        if (!fullRoom || !sender) return
        const preview = (content?.trim() || "📎 Archivo").slice(0, 80)
        for (const p of fullRoom.participants) {
          if (p._id.toString() === req.user.userId.toString()) continue
          await enviarPushNotification(p, { title: `💬 ${sender.name}`, body: preview, url: `/admin/chat?room=${req.params.roomId}`, tag: `chat-${req.params.roomId}` })
        }
      } catch(e) {}
    })
  } catch (e) { handleError(res, e, "Failed to send message") }
})

// ============================================================
// PUSH — Send endpoints
// ============================================================
app.post("/api/push/send", authenticateToken, async (req, res) => {
  try {
    const { userId: targetId, title, body, url } = req.body
    const target = await User.findById(targetId)
    if (!target) return res.status(404).json({ success: false, error: "Usuario no encontrado" })
    const sent = await enviarPushNotification(target, { title, body, url: url || "/" })
    res.json({ success: true, sent })
  } catch (e) { handleError(res, e, "Failed to send push") }
})

// ============================================================
// SEGUROS — Dashboard
// ============================================================
app.get("/api/seguros/dashboard", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date()
    const year  = parseInt(req.query.year)  || now.getFullYear()
    const month = parseInt(req.query.month) || (now.getMonth() + 1)
    const startOfMonth = new Date(year, month - 1, 1)
    const endOfMonth   = new Date(year, month, 0, 23, 59, 59, 999)
    const mesKey = `${year}-${String(month).padStart(2,"0")}`

    const [
      totalVigentes, totalAnuladas, totalPendientes,
      totalSiniestros, siniestrosEnTramite,
      porAseguradora, porRamo,
      emitidasEsteMes, anuladasEsteMes,
      debitoAutomatico, debitoCBU, debitoTarjCred,
      vigentesEfectivo, vigentesDebito,
      efectivoStats, totalCobranzas,
    ] = await Promise.all([
      Poliza.countDocuments({ estado: "VIGENTE" }),
      Poliza.countDocuments({ estado: "ANULADA" }),
      Poliza.countDocuments({ estado: "PENDIENTE_CLIENTE" }),
      Siniestro.countDocuments(),
      Siniestro.countDocuments({ estado: "EN_TRAMITE" }),
      Poliza.aggregate([{ $match: { estado: "VIGENTE" } }, { $group: { _id: "$aseguradora", total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Poliza.aggregate([{ $match: { estado: "VIGENTE" } }, { $group: { _id: "$ramo", total: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Poliza.countDocuments({ fechaInicVig: { $gte: startOfMonth, $lte: endOfMonth } }),
      Poliza.countDocuments({ estado: "ANULADA", fechaAnulacion: { $gte: startOfMonth, $lte: endOfMonth } }),
      Poliza.countDocuments({ estado: "VIGENTE", medioDePago: { $in: ["CBU","TARJ_CRED"] } }),
      Poliza.countDocuments({ estado: "VIGENTE", medioDePago: "CBU" }),
      Poliza.countDocuments({ estado: "VIGENTE", medioDePago: "TARJ_CRED" }),
      Poliza.countDocuments({ estado: "VIGENTE", medioDePago: { $in: ["CUPON","EFECTIVO"] } }),
      Poliza.countDocuments({ estado: "VIGENTE", medioDePago: { $nin: ["CUPON","EFECTIVO"] } }),
      CobranzaEfectivo.aggregate([{ $unwind: { path: "$pagos", preserveNullAndEmptyArrays: false } }, { $match: { "pagos.mes": mesKey } }, { $group: { _id: "$pagos.estado", total: { $sum: 1 } } }]),
      CobranzaEfectivo.countDocuments({}),
    ])

    const efectivoByEstado = {}
    for (const e of efectivoStats) efectivoByEstado[e._id] = e.total

    const cob    = efectivoByEstado["COBRADA"]         || 0
    const cupon  = efectivoByEstado["CUPON_ENVIADO"]   || 0
    const venc   = efectivoByEstado["CUOTA_VENCIDA"]   || 0
    const comp   = efectivoByEstado["COMPROMISO_PAGO"] || 0
    const noCorr = efectivoByEstado["NO_CORRESPONDE"]  || 0
    const anulC  = efectivoByEstado["ANULADA"]         || 0
    const pend   = efectivoByEstado["PENDIENTE"]       || 0

    res.json({ success: true, stats: {
      totalVigentes, totalAnuladas, totalPendientes,
      totalSiniestros, siniestrosEnTramite,
      porAseguradora, porRamo,
      emitidasEsteMes, anuladasEsteMes,
      debitoAutomatico, debitoCBU, debitoTarjCred,
      vigentesEfectivo, vigentesDebito, totalCobranzas,
      efectivoCobradas: cob, efectivoCuponEnviado: cupon, efectivoCuotaVencida: venc,
      efectivoCompromisoPago: comp, efectivoNoCorresponde: noCorr, efectivoPendiente: pend,
    }})
  } catch (e) { handleError(res, e, "Error fetching seguros dashboard") }
})

// ============================================================
// SEGUROS — Email Masivo
// ============================================================
app.get("/api/seguros/email-masivo/preview", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { tipo = "todos", ids } = req.query
    let filter = { email: { $exists: true, $ne: "" } }
    if (tipo === "vigentes") filter.estado = "VIGENTE"
    else if (tipo === "anulados") filter.estado = "ANULADA"
    else if (tipo === "individual") {
      if (!ids) return res.json({ success: true, count: 0 })
      const polizas = await Poliza.find({ _id: { $in: ids.split(",") }, email: { $exists: true, $ne: "" } }, { email: 1 })
      return res.json({ success: true, count: [...new Set(polizas.map(p => p.email.trim().toLowerCase()).filter(Boolean))].length })
    } else filter.estado = { $in: ["VIGENTE","ANULADA"] }
    const polizas = await Poliza.find(filter, { email: 1 })
    const uniqueEmails = [...new Set(polizas.map(p => p.email.trim().toLowerCase()).filter(Boolean))]
    res.json({ success: true, count: uniqueEmails.length })
  } catch (e) { handleError(res, e, "Error en preview email masivo") }
})

app.get("/api/seguros/email-masivo/search", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q } = req.query
    if (!q || q.trim().length < 2) return res.json({ success: true, polizas: [] })
    const polizas = await Poliza.find({ nombreApellido: new RegExp(q.trim(), "i"), email: { $exists: true, $ne: "" } }, { nombreApellido: 1, email: 1, estado: 1, aseguradora: 1 }).limit(20)
    res.json({ success: true, polizas })
  } catch (e) { handleError(res, e, "Error en search email masivo") }
})

app.post("/api/seguros/email-masivo", authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!transporter) return res.status(503).json({ error: "Servicio de email no configurado" })
    const { asunto, mensaje, imagenBase64, imagenMime, destinatario = "todos", polizaIds } = req.body
    if (!asunto?.trim()) return res.status(400).json({ error: "El asunto es requerido" })
    if (!mensaje?.trim()) return res.status(400).json({ error: "El mensaje es requerido" })

    let filter = { email: { $exists: true, $ne: "" } }
    if (destinatario === "vigentes") filter.estado = "VIGENTE"
    else if (destinatario === "anulados") filter.estado = "ANULADA"
    else if (destinatario === "individual") {
      if (!polizaIds?.length) return res.status(400).json({ error: "Seleccionar al menos un destinatario" })
      filter._id = { $in: polizaIds }
    } else filter.estado = { $in: ["VIGENTE","ANULADA"] }

    const polizas = await Poliza.find(filter, { email: 1, nombreApellido: 1 })
    const seen = new Set()
    const lista = []
    for (const p of polizas) {
      const norm = p.email.trim().toLowerCase()
      if (norm && !seen.has(norm)) { seen.add(norm); lista.push({ email: p.email.trim(), nombreApellido: p.nombreApellido }) }
    }

    const imagenCid = (imagenBase64 && imagenMime) ? "anuncio_img_cid" : null
    const tmpl = buildEmailMasivoTemplate({ asunto, mensaje, imagenCid })
    const attachments = []
    if (imagenBase64 && imagenMime) {
      const ext = imagenMime.split("/")[1] || "png"
      attachments.push({ filename: `anuncio.${ext}`, content: Buffer.from(imagenBase64,"base64"), cid: "anuncio_img_cid", contentType: imagenMime })
    }

    const enviados = [], fallidos = []
    for (const dest of lista) {
      try {
        await transporter.sendMail({ from: `"WAC Seguros" <${EMAIL_FROM}>`, to: dest.email, subject: tmpl.subject, html: tmpl.html, attachments })
        enviados.push(dest.email)
      } catch (err) { fallidos.push({ email: dest.email, error: err.message }) }
    }
    res.json({ success: true, totalDestinatarios: lista.length, enviados: enviados.length, fallidos: fallidos.length, detalleFallidos: fallidos })
  } catch (e) { handleError(res, e, "Error en email masivo") }
})

// ============================================================
// SEGUROS — Pólizas
// ============================================================
app.get("/api/seguros/polizas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { estado, aseguradora, ramo, search, page = 1, limit = 100, year, month } = req.query
    const filter = {}
    if (estado) filter.estado = estado
    if (aseguradora) filter.aseguradora = aseguradora
    if (ramo) filter.ramo = ramo
    if (year && month) {
      filter.fechaInicVig = { $gte: new Date(parseInt(year), parseInt(month)-1, 1), $lte: new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999) }
    }
    if (search) filter.$or = [
      { nombreApellido: { $regex: search, $options: "i" } },
      { patente: { $regex: search, $options: "i" } },
      { numPoliza: { $regex: search, $options: "i" } },
      { dni: { $regex: search, $options: "i" } },
    ]
    const skip = (parseInt(page)-1) * parseInt(limit)
    const [polizas, total, statsVigentes, statsAnuladas, statsPendientes] = await Promise.all([
      Poliza.find(filter).sort({ fechaInicVig: -1, createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Poliza.countDocuments(filter),
      Poliza.countDocuments({ estado: "VIGENTE" }),
      Poliza.countDocuments({ estado: "ANULADA" }),
      Poliza.countDocuments({ estado: "PENDIENTE_CLIENTE" }),
    ])
    res.json({ success: true, polizas, total, page: parseInt(page), totalPages: Math.ceil(total/parseInt(limit)), stats: { vigentes: statsVigentes, anuladas: statsAnuladas, pendientes: statsPendientes } })
  } catch (e) { handleError(res, e, "Error fetching polizas") }
})

async function syncCobranzaEfectivo(poliza, userId) {
  if (!["CUPON","EFECTIVO"].includes(poliza.medioDePago) || poliza.estado === "ANULADA") return false
  if (await CobranzaEfectivo.findOne({ polizaId: poliza._id })) return false
  let diaVto, pagos = []
  if (poliza.fechaInicVig) {
    const fecha = new Date(poliza.fechaInicVig)
    diaVto = fecha.getUTCDate()
    const mesKey = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth()+1).padStart(2,"0")}`
    const mesLabel = `${MES_LABELS[fecha.getUTCMonth()]} ${fecha.getUTCFullYear()}`
    pagos = [{ mes: mesKey, mesLabel, estado: "PENDIENTE" }]
  }
  await new CobranzaEfectivo({ polizaId: poliza._id, nombreApellido: poliza.nombreApellido, aseguradora: poliza.aseguradora, patente: poliza.patente, datosRiesgo: poliza.datosRiesgo, whatsapp: poliza.celular, email: poliza.email, ramo: poliza.ramo, diaVto, pagos, creadoPor: userId }).save()
  return true
}

app.post("/api/seguros/polizas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const poliza = new Poliza({ ...req.body, creadoPor: req.user.userId, updatedAt: new Date() })
    await poliza.save()
    let cobranzaCreada = false
    try { cobranzaCreada = await syncCobranzaEfectivo(poliza, req.user.userId) } catch(e){}
    res.status(201).json({ success: true, poliza, cobranzaCreada })
  } catch (e) { handleError(res, e, "Error creating poliza") }
})

app.put("/api/seguros/polizas/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const poliza = await Poliza.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true })
    if (!poliza) return res.status(404).json({ error: "Póliza no encontrada" })
    let cobranzaCreada = false
    try { cobranzaCreada = await syncCobranzaEfectivo(poliza, req.user.userId) } catch(e){}
    res.json({ success: true, poliza, cobranzaCreada })
  } catch (e) { handleError(res, e, "Error updating poliza") }
})

app.delete("/api/seguros/polizas/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await Poliza.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Error deleting poliza") }
})

// ============================================================
// SEGUROS — Siniestros
// ============================================================
app.get("/api/seguros/siniestros", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { estado, compania, tipoSiniestro, search, year, month } = req.query
    const filter = {}
    if (estado) filter.estado = estado
    if (compania) filter.compania = compania
    if (tipoSiniestro) filter.tipoSiniestro = tipoSiniestro
    if (year && month) filter.fechaOcurrencia = { $gte: new Date(parseInt(year), parseInt(month)-1, 1), $lte: new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999) }
    if (search) filter.$or = [
      { asegurado: { $regex: search, $options: "i" } },
      { numPoliza: { $regex: search, $options: "i" } },
      { numeroSiniestro: { $regex: search, $options: "i" } },
    ]
    const siniestros = await Siniestro.find(filter).sort({ fechaOcurrencia: -1, createdAt: -1 })
    res.json({ success: true, siniestros })
  } catch (e) { handleError(res, e, "Error fetching siniestros") }
})

app.post("/api/seguros/siniestros", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const siniestro = new Siniestro({ ...req.body, creadoPor: req.user.userId })
    await siniestro.save()
    res.status(201).json({ success: true, siniestro })
  } catch (e) { handleError(res, e, "Error creating siniestro") }
})

app.put("/api/seguros/siniestros/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { _id, __v, creadoPor, createdAt, ...updateData } = req.body
    const siniestro = await Siniestro.findByIdAndUpdate(req.params.id, { ...updateData, updatedAt: new Date() }, { new: true, runValidators: true })
    if (!siniestro) return res.status(404).json({ error: "Siniestro no encontrado" })
    res.json({ success: true, siniestro })
  } catch (e) { handleError(res, e, "Error updating siniestro") }
})

app.delete("/api/seguros/siniestros/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await Siniestro.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Error deleting siniestro") }
})

// ============================================================
// SEGUROS — Cobranzas en Efectivo
// ============================================================
app.get("/api/seguros/cobranzas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { sucursal, aseguradora, mes, search } = req.query
    const filter = {}
    if (sucursal) filter.sucursal = sucursal
    if (aseguradora) filter.aseguradora = aseguradora
    if (search) filter.$or = [{ nombreApellido: { $regex: search, $options: "i" } }, { patente: { $regex: search, $options: "i" } }]
    let cobranzas = await CobranzaEfectivo.find(filter).sort({ nombreApellido: 1 })
    if (mes) cobranzas = cobranzas.filter(c => c.pagos.some(p => p.mes === mes))
    res.json({ success: true, cobranzas })
  } catch (e) { handleError(res, e, "Error fetching cobranzas") }
})

app.post("/api/seguros/cobranzas/sync-vencidas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const today = new Date()
    const mesKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}`
    const result = await CobranzaEfectivo.updateMany(
      { diaVto: { $exists: true, $ne: null, $lt: today.getDate() }, pagos: { $elemMatch: { mes: mesKey, estado: { $in: ["PENDIENTE","CUPON_ENVIADO"] } } } },
      { $set: { "pagos.$[elem].estado": "CUOTA_VENCIDA", updatedAt: new Date() } },
      { arrayFilters: [{ "elem.mes": mesKey, "elem.estado": { $in: ["PENDIENTE","CUPON_ENVIADO"] } }] }
    )
    res.json({ success: true, updated: result.modifiedCount })
  } catch (e) { handleError(res, e, "Error syncing vencidas") }
})

app.post("/api/seguros/cobranzas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cobranza = new CobranzaEfectivo({ ...req.body, creadoPor: req.user.userId })
    await cobranza.save()
    res.status(201).json({ success: true, cobranza })
  } catch (e) { handleError(res, e, "Error creating cobranza") }
})

app.put("/api/seguros/cobranzas/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cobranza = await CobranzaEfectivo.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true })
    if (!cobranza) return res.status(404).json({ error: "Cobranza no encontrada" })
    res.json({ success: true, cobranza })
  } catch (e) { handleError(res, e, "Error updating cobranza") }
})

app.patch("/api/seguros/cobranzas/:id/pago", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { mes, mesLabel, estado, cobradoPor, fechaCobro } = req.body
    const cobranza = await CobranzaEfectivo.findById(req.params.id)
    if (!cobranza) return res.status(404).json({ error: "Cobranza no encontrada" })
    const pagoIdx = cobranza.pagos.findIndex(p => p.mes === mes)
    const update = { estado }
    if (cobradoPor !== undefined) update.cobradoPor = cobradoPor
    if (fechaCobro !== undefined) update.fechaCobro = fechaCobro ? new Date(fechaCobro) : null
    if (pagoIdx >= 0) Object.assign(cobranza.pagos[pagoIdx], update)
    else cobranza.pagos.push({ mes, mesLabel: mesLabel || mes, ...update })
    cobranza.updatedAt = new Date()
    await cobranza.save()
    res.json({ success: true, cobranza })
  } catch (e) { handleError(res, e, "Error updating pago") }
})

app.delete("/api/seguros/cobranzas/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await CobranzaEfectivo.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Error deleting cobranza") }
})

// ── Notificaciones de cobranzas por email ────────────────────────────────────
function getMesLabelNotif(mesKey) {
  const [year, month] = mesKey.split("-").map(Number)
  return `${MES_LABELS[month-1]} ${year}`
}

app.post("/api/seguros/cobranzas/notificaciones/enviar", authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!transporter) return res.status(503).json({ error: "Servicio de email no configurado" })
    const { tipo, mes } = req.body
    if (!["proximo_vencer","vence_hoy","vencido"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido" })
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: "Mes inválido (formato YYYY-MM)" })

    const todayDay = new Date().getDate()
    const mesLabel = getMesLabelNotif(mes)
    const cobranzas = await CobranzaEfectivo.find({})
    const enviados = [], fallidos = [], sinEmail = [], yaEnviados = []

    for (const c of cobranzas) {
      const pago = c.pagos.find(p => p.mes === mes)
      let eligible = false
      if (tipo === "proximo_vencer") eligible = typeof c.diaVto === "number" && (c.diaVto === todayDay+1 || c.diaVto === todayDay+2)
      else if (tipo === "vence_hoy") eligible = typeof c.diaVto === "number" && c.diaVto === todayDay
      else if (tipo === "vencido") eligible = !!(pago && pago.estado === "CUOTA_VENCIDA")
      if (!eligible) continue

      if (c.emailNotificaciones.some(n => n.tipo === tipo && n.mes === mes && n.estado === "enviado")) { yaEnviados.push({ _id: c._id, nombreApellido: c.nombreApellido }); continue }
      if (!c.email) { sinEmail.push({ _id: c._id, nombreApellido: c.nombreApellido }); continue }

      try {
        const tmpl = buildEmailTemplate(tipo, { nombreApellido: c.nombreApellido, aseguradora: c.aseguradora, patente: c.patente, ramo: c.ramo, datosRiesgo: c.datosRiesgo, diaVto: c.diaVto, mesLabel })
        await transporter.sendMail({ from: `"WAC Seguros" <${EMAIL_FROM}>`, to: c.email, subject: tmpl.subject, html: tmpl.html })
        c.emailNotificaciones.push({ tipo, mes, enviadoEn: new Date(), estado: "enviado" })
        c.updatedAt = new Date()
        await c.save()
        enviados.push({ _id: c._id, nombreApellido: c.nombreApellido, email: c.email })
      } catch (err) {
        c.emailNotificaciones.push({ tipo, mes, enviadoEn: new Date(), estado: "error", errorMsg: err.message })
        c.updatedAt = new Date()
        await c.save()
        fallidos.push({ _id: c._id, nombreApellido: c.nombreApellido, email: c.email, error: err.message })
      }
    }
    res.json({ success: true, tipo, mes, results: { enviados, fallidos, sinEmail, yaEnviados } })
  } catch (e) { handleError(res, e, "Error enviando notificaciones") }
})

app.post("/api/seguros/cobranzas/:id/notificacion", authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!transporter) return res.status(503).json({ error: "Servicio de email no configurado" })
    const { tipo, mes } = req.body
    if (!["proximo_vencer","vence_hoy","vencido"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido" })
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: "Mes inválido" })

    const c = await CobranzaEfectivo.findById(req.params.id)
    if (!c) return res.status(404).json({ error: "Cobranza no encontrada" })
    if (!c.email) return res.status(400).json({ error: "Este cliente no tiene email registrado" })

    const mesLabel = getMesLabelNotif(mes)
    const tmpl = buildEmailTemplate(tipo, { nombreApellido: c.nombreApellido, aseguradora: c.aseguradora, patente: c.patente, ramo: c.ramo, datosRiesgo: c.datosRiesgo, diaVto: c.diaVto, mesLabel })
    let emailOk = false, emailErr = null
    try {
      await transporter.sendMail({ from: `"WAC Seguros" <${EMAIL_FROM}>`, to: c.email, subject: tmpl.subject, html: tmpl.html })
      emailOk = true
      c.emailNotificaciones.push({ tipo, mes, enviadoEn: new Date(), estado: "enviado" })
    } catch (err) {
      emailErr = err.message
      c.emailNotificaciones.push({ tipo, mes, enviadoEn: new Date(), estado: "error", errorMsg: err.message })
    }
    c.updatedAt = new Date()
    await c.save()
    if (!emailOk) return res.status(422).json({ success: false, error: "No se pudo enviar el email", detail: emailErr, cobranza: c })
    res.json({ success: true, cobranza: c })
  } catch (e) { handleError(res, e, "Error enviando notificación") }
})

// ============================================================
// SEGUROS — Seguimiento de Prospectos
// ============================================================
app.get("/api/seguros/seguimiento", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { estado, search, year, month } = req.query
    const filter = {}
    if (estado) filter.estado = estado
    if (year && month) filter.fechaContacto = { $gte: new Date(parseInt(year), parseInt(month)-1, 1), $lte: new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999) }
    if (search) filter.$or = [
      { nombre: { $regex: search, $options: "i" } }, { apellido: { $regex: search, $options: "i" } },
      { patente: { $regex: search, $options: "i" } }, { celular: { $regex: search, $options: "i" } },
      { dni: { $regex: search, $options: "i" } },
    ]
    const seguimientos = await Seguimiento.find(filter).sort({ fechaContacto: -1, createdAt: -1 })
    res.json({ success: true, seguimientos })
  } catch (e) { handleError(res, e, "Error fetching seguimientos") }
})

app.post("/api/seguros/seguimiento", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const seg = new Seguimiento({ ...req.body, creadoPor: req.user.userId })
    await seg.save()
    res.status(201).json({ success: true, seguimiento: seg })
  } catch (e) { handleError(res, e, "Error creating seguimiento") }
})

app.put("/api/seguros/seguimiento/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const seg = await Seguimiento.findByIdAndUpdate(req.params.id, { ...req.body }, { new: true })
    if (!seg) return res.status(404).json({ error: "Seguimiento no encontrado" })
    res.json({ success: true, seguimiento: seg })
  } catch (e) { handleError(res, e, "Error updating seguimiento") }
})

app.delete("/api/seguros/seguimiento/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await Seguimiento.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (e) { handleError(res, e, "Error deleting seguimiento") }
})

// ============================================================
// SERVER START
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 WAC Seguros Backend corriendo en puerto ${PORT}`)
  console.log(`📋 Ramos: ${RAMOS.join(", ")}`)
  console.log(`🏢 Aseguradoras: ${ASEGURADORAS.length} configuradas`)
})
