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
const DAILY_LIMIT = 500 // Limite por usuário (por licenseKey)

// ===================== GMAIL SMTP (Configurado para Render) =====================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,   // ← Use a Senha de App aqui
  },
  family: 4, // Força IPv4 (importante no Render)
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
})

// ===================== SUPABASE =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ===================== FUNÇÕES DE CONTROLE DIÁRIO =====================
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

  const { data: updated } = await supabase
    .from('daily_sends')
    .update({ count: supabase.raw('count + 1') })
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .select()
    .maybeSingle()

  if (updated) return updated.count

  // Cria novo registro se não existir
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

// ===================== OUTRAS FUNÇÕES =====================
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
  res.json({ ok: true, message: 'Backend com limite de 500/dia por usuário' })
})

// ... (rotas de generate-key, licenses, activate-key podem ficar iguais)

// ===================== ENVIO DE CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey
    } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 NOVA CANDIDATURA')
    console.log('👤 Cliente:', candidateName)
    console.log('📧 Email:', candidateEmail)
    console.log('🔑 LicenseKey:', licenseKey)
    console.log('═══════════════════════════════════════════')

    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: 'LicenseKey não informada.' })
    }

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ 
        ok: false, 
        error: `Limite diário de ${DAILY_LIMIT} envios atingido para esta conta.` 
      })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    const employerHtml = `...` // (você pode manter seu HTML bonito aqui)

    const targetEmail = process.env.TEST_EMPLOYER_EMAIL || employerEmail

    // Envio para empregador
    if (targetEmail && targetEmail.includes('@')) {
      await transporter.sendMail({
        from: `"${candidateName} via FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
        to: targetEmail,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      console.log(`✅ E-mail enviado para empregador: ${targetEmail}`)
    }

    // Confirmação para o cliente
    const candidateHtml = `...` // (seu HTML de confirmação)

    await transporter.sendMail({
      from: `"FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada — ${jobTitle}`,
      html: candidateHtml,
      attachments: emailAttachments,
    })
    console.log(`✅ Confirmação enviada para cliente: ${candidateEmail}`)

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
  console.log(`✅ Backend rodando na porta ${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log(`📊 Limite: ${DAILY_LIMIT} envios/dia POR USUÁRIO`)
  console.log('═══════════════════════════════════════════')
})