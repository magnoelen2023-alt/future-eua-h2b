import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import nodemailer from 'nodemailer'
import { createClient } from '@supabase/supabase-js'

const app = express()

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'
const DAILY_LIMIT = 500

// ===================== GMAIL SMTP =====================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
  family: 4,
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
})

// ===================== SUPABASE =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ===================== CONTROLE DIÁRIO =====================
async function getDailyCount(licenseKey) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('daily_sends')
    .select('count')
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .maybeSingle()

  if (error) {
    console.error('Erro getDailyCount:', error.message)
    return 0
  }
  return data?.count || 0
}

async function incrementDailyCount(licenseKey, userEmail) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]

  const { data: existing } = await supabase
    .from('daily_sends')
    .select('id, count')
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .maybeSingle()

  if (existing) {
    const newCount = (existing.count || 0) + 1
    const { data: updated } = await supabase
      .from('daily_sends')
      .update({ count: newCount })
      .eq('id', existing.id)
      .select()
      .single()
    return updated?.count || newCount
  }

  const { data: inserted } = await supabase
    .from('daily_sends')
    .insert([{
      license_key: licenseKey,
      user_email: userEmail,
      send_date: today,
      count: 1
    }])
    .select()
    .single()

  return inserted?.count || 1
}

// ===================== FUNÇÕES AUXILIARES =====================
function generatePremiumKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const gen = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${gen(4)}-${gen(4)}-${gen(4)}-${gen(4)}`
}

function addDays(date, days) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function cleanKey(value = '') {
  return String(value).trim().toUpperCase()
}

function normalizeLockedProfile(user = {}) {
  return {
    name: user.name || '',
    email: user.email || '',
    address: user.address || '',
    cep: user.cep || '',
    state: user.state || '',
    country: user.country || '',
  }
}

function requireAdmin(req, res) {
  const received = req.headers['x-admin-secret'] || req.query.secret || req.body?.secret
  if (received !== ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: 'Acesso administrativo negado.' })
    return false
  }
  return true
}

async function downloadFileFromUrl(url) {
  try {
    if (!url || url === 'null' || url === 'undefined') return null
    const response = await fetch(url)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error(`❌ Erro download: ${error.message}`)
    return null
  }
}

async function prepareAttachments(attachments = []) {
  const prepared = []
  for (const att of attachments) {
    if (!att?.url) continue
    try {
      const buffer = await downloadFileFromUrl(att.url)
      if (buffer && buffer.length > 0) {
        const urlPath = new URL(att.url).pathname
        const ext = urlPath.split('.').pop() || 'pdf'
        prepared.push({
          filename: att.filename || `documento.${ext}`,
          content: buffer
        })
      }
    } catch (error) {
      console.error(`❌ Erro anexo: ${error.message}`)
    }
  }
  return prepared
}

// ===================== ROTAS =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend v5 - Gmail SMTP + 500/dia por usuário' })
})

// GERAR KEY
app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const email = (req.query.email || '').toLowerCase()
    const days = parseInt(req.query.days) || 180
    const key = generatePremiumKey()
    const { data, error } = await supabase
      .from('licenses')
      .insert([{
        key,
        status: 'unused',
        assigned_email: email,
        days_valid: days,
        max_daily: 500
      }])
      .select()
      .single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// LISTAR KEYS
app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { data } = await supabase.from('licenses').select('*').order('created_at', { ascending: false })
  return res.json({ ok: true, licenses: data })
})

// ATIVAR KEY
app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body
    if (!key || !user?.email) return res.status(400).json({ ok: false, error: 'Dados faltantes.' })
    const cleanedKey = cleanKey(key)
    const userEmail = user.email.trim().toLowerCase()
    const { data: license, error: findError } = await supabase.from('licenses').select('*').eq('key', cleanedKey).single()
    if (findError || !license) return res.status(404).json({ ok: false, error: 'Chave inválida.' })
    
    if (license.status === 'active') {
      if (license.assigned_email !== userEmail) return res.status(403).json({ ok: false, error: 'Chave de outro usuário.' })
      return res.json({ ok: true, license })
    }

    const now = new Date()
    const expiresAt = addDays(now, license.days_valid || 180)
    const { data: updated, error: updateError } = await supabase.from('licenses').update({
      status: 'active',
      assigned_email: userEmail,
      locked_profile: normalizeLockedProfile(user),
      activated_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    }).eq('key', cleanedKey).select().single()

    if (updateError) return res.status(500).json({ ok: false, error: updateError.message })
    return res.json({ ok: true, license: updated })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// ===================== ENVIO DE CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey
    } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 NOVA CANDIDATURA')
    console.log('👤 Candidato:', candidateName)
    console.log('📧 Email:', candidateEmail)
    console.log('🏢 Empregador:', employerName)
    console.log('🔑 LicenseKey:', licenseKey)
    console.log('═══════════════════════════════════════════')

    if (!licenseKey) return res.status(400).json({ ok: false, error: 'LicenseKey não informada.' })
    if (!candidateEmail || !jobTitle) return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: `Limite diário de ${DAILY_LIMIT} atingido.` })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #1a3a8f; color: white; padding: 20px; text-align: center;">
          <h2>Job Application — ${jobTitle}</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <p>${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <h3>Candidate Information</h3>
          <p><strong>Name:</strong> ${candidateName}</p>
          <p><strong>Email:</strong> ${candidateEmail}</p>
          <p><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
        </div>
      </div>
    `

    // Envio para o empregador
    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      await transporter.sendMail({
        from: `"${candidateName} via FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
        to: employerTargetEmail,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      console.log(`✅ E-mail enviado para empregador: ${employerTargetEmail}`)
    }

    // Confirmação para o cliente
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto;">
        <h2>✅ Candidatura enviada com sucesso!</h2>
        <p>Olá <strong>${candidateName}</strong>,</p>
        <p>Sua candidatura para <strong>${jobTitle}</strong> na empresa <strong>${employerName}</strong> foi enviada.</p>
        <p><strong>Envios hoje:</strong> ${currentCount + 1} de ${DAILY_LIMIT}</p>
        <p>Qualquer resposta do empregador chegará diretamente no seu e-mail.</p>
      </div>
    `

    await transporter.sendMail({
      from: `"FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada — ${jobTitle}`,
      html: candidateHtml,
      attachments: emailAttachments,
    })
    console.log(`✅ Confirmação enviada para: ${candidateEmail}`)

    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    return res.json({
      ok: true,
      message: 'Candidatura enviada com sucesso!',
      dailySent: newCount,
      dailyLimit: DAILY_LIMIT,
      remaining: DAILY_LIMIT - newCount
    })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend v5 rodando na porta ${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log(`📊 Limite: ${DAILY_LIMIT} envios/dia POR USUÁRIO`)
  console.log('═══════════════════════════════════════════')
})