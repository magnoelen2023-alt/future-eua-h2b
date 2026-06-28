import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import nodemailer from 'nodemailer'
import { createClient } from '@supabase/supabase-js'
import dns from 'dns' // Importação necessária para forçar IPv4

const app = express()

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json({ limit: '25mb' }))

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'
const DAILY_LIMIT = 500

// ===================== GMAIL SMTP (FORÇANDO IPv4) =====================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
  // ESTA FUNÇÃO ABAIXO É O QUE RESOLVE O ERRO ENETUNREACH DEFINITIVAMENTE
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4 }, callback)
  },
  tls: {
    rejectUnauthorized: false,
    servername: 'smtp.gmail.com'
  }
})

// ===================== SUPABASE =====================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ===================== CONTROLE DIÁRIO =====================
async function getDailyCount(licenseKey) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase.from('daily_sends').select('count').eq('license_key', licenseKey).eq('send_date', today).maybeSingle()
  return data?.count || 0
}

async function incrementDailyCount(licenseKey, userEmail) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]
  const current = await getDailyCount(licenseKey)
  const newCount = current + 1

  await supabase.from('daily_sends').upsert({
    license_key: licenseKey,
    user_email: userEmail,
    send_date: today,
    count: newCount
  }, { onConflict: 'license_key,send_date' })

  return newCount
}

// ===================== FUNÇÕES AUXILIARES =====================
function generatePremiumKey() {
  const gen = (n) => Array.from({length: n}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*31)]).join('')
  return `${gen(4)}-${gen(4)}-${gen(4)}-${gen(4)}`
}

async function downloadFileFromUrl(url) {
  try {
    if (!url) return null
    const response = await fetch(url)
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null
  } catch (e) { return null }
}

async function prepareAttachments(attachments = []) {
  const prepared = []
  for (const att of (Array.isArray(attachments) ? attachments : [])) {
    if (!att?.url) continue
    const buffer = await downloadFileFromUrl(att.url)
    if (buffer) {
      prepared.push({ filename: att.filename || 'documento.pdf', content: buffer })
    }
  }
  return prepared
}

// ===================== ROTAS =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend v6 - IPv4 Forçado' })
})

app.get('/api/admin/generate-key', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret
  if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false })
  const key = generatePremiumKey()
  await supabase.from('licenses').insert([{ key, status: 'unused', assigned_email: req.query.email, days_valid: 180 }])
  res.json({ ok: true, key })
})

app.post('/api/activate-key', async (req, res) => {
  const { key, user } = req.body
  const { data: lic } = await supabase.from('licenses').select('*').eq('key', key.toUpperCase()).single()
  if (!lic) return res.status(404).json({ ok: false })
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 180)
  const { data: upd } = await supabase.from('licenses').update({ status: 'active', assigned_email: user.email, activated_at: new Date().toISOString(), expires_at: expiresAt.toISOString() }).eq('key', key.toUpperCase()).select().single()
  res.json({ ok: true, userUpdate: { premium: true, premiumExpiresAt: expiresAt.toISOString() } })
})

app.post('/api/send-candidature', async (req, res) => {
  try {
    const { candidateName, candidateEmail, candidatePhone, employerName, employerEmail, jobTitle, jobLocation, messageBody, attachments, licenseKey } = req.body

    console.log(`📨 ENVIANDO: ${candidateName} -> ${employerName}`)

    const currentCount = await getDailyCount(licenseKey || candidateEmail)
    if (currentCount >= DAILY_LIMIT) return res.status(429).json({ ok: false, error: 'Limite diário atingido' })

    const emailAttachments = await prepareAttachments(attachments)

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; border: 1px solid #eee; padding: 20px;">
        <h2 style="color: #1a3a8f;">Job Application — ${jobTitle}</h2>
        <p>Dear Hiring Manager at ${employerName},</p>
        <p style="white-space: pre-line;">${messageBody}</p>
        <hr>
        <p><strong>Candidate:</strong> ${candidateName}<br><strong>Email:</strong> ${candidateEmail}<br><strong>Phone:</strong> ${candidatePhone}</p>
      </div>
    `

    const target = process.env.TEST_EMPLOYER_EMAIL || employerEmail

    // Envio Empregador
    if (target?.includes('@')) {
      await transporter.sendMail({
        from: `"${candidateName} via Future EUA" <${process.env.GMAIL_USER}>`,
        to: target,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: emailHtml,
        attachments: emailAttachments
      })
    }

    // Cópia Candidato
    await transporter.sendMail({
      from: `"Future EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Cópia: Candidatura enviada para ${employerName}`,
      html: `<div style="background:#e6f4ea;padding:10px;">Cópia do e-mail enviado.</div>${emailHtml}`,
      attachments: emailAttachments
    })

    const newCount = await incrementDailyCount(licenseKey || candidateEmail, candidateEmail)
    res.json({ ok: true, dailySent: newCount })

  } catch (error) {
    console.error('❌ ERRO:', error.message)
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => console.log(`✅ v6 Online na porta ${PORT}`))