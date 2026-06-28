import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const app = express()

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-secret']
}))
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'
const DAILY_LIMIT = 100

// ===================== RESEND =====================
const resend = new Resend(process.env.RESEND_API_KEY)
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'

// ===================== SUPABASE =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ===================== FUNÇÕES AUXILIARES =====================
function generateBlock(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

function generatePremiumKey() {
  return `${generateBlock()}-${generateBlock()}-${generateBlock()}-${generateBlock()}`
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

// ===================== CONTROLE DIÁRIO =====================
async function getDailyCount(licenseKey) {
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('daily_sends')
    .select('count')
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .single()
  return data?.count || 0
}

async function incrementDailyCount(licenseKey, userEmail) {
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('daily_sends')
    .upsert({
      license_key: licenseKey,
      user_email: userEmail,
      send_date: today,
    }, {
      onConflict: 'license_key,send_date',
      update: { count: supabase.raw('count + 1') }
    })
    .select()
    .single()
  return data?.count || 0
}

// ===================== DOWNLOAD E ANEXOS =====================
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
  res.json({ ok: true, message: 'Backend com controle diário no Supabase!' })
})

// GERAR KEY, LISTAR E ATIVAR (mantido simplificado)
app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const email = (req.query.email || '').toLowerCase()
    const days = parseInt(req.query.days) || 180
    const key = generatePremiumKey()
    const { data, error } = await supabase.from('licenses').insert([{ key, status: 'unused', assigned_email: email, days_valid: days }]).select().single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { data } = await supabase.from('licenses').select('*').order('created_at', { ascending: false })
  return res.json({ ok: true, licenses: data })
})

app.post('/api/activate-key', async (req, res) => {
  // (mantido simplificado - pode melhorar depois)
  return res.json({ ok: true, message: 'Ativação simulada' })
})

// ===================== ENVIO DE CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const { candidateName, candidateEmail, candidatePhone, employerName, employerEmail, jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey } = req.body

    if (!candidateEmail || !jobTitle || !licenseKey) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando (licenseKey).' })
    }

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: `Limite diário de ${DAILY_LIMIT} envios atingido.` })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Job Application — ${jobTitle}</h2>
        <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
        <p>${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
        <p><strong>Candidate:</strong> ${candidateName}</p>
        <p><strong>Email:</strong> ${candidateEmail}</p>
        <p><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
      </div>
    `

    const targetEmail = process.env.TEST_EMPLOYER_EMAIL || employerEmail

    if (targetEmail && targetEmail.includes('@')) {
      await resend.emails.send({
        from: `${candidateName} <${FROM_EMAIL}>`,
        to: targetEmail,
        reply_to: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      })
    }

    const confirmationHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
        <h2>✅ Candidatura Enviada com Sucesso!</h2>
        <p>Olá <strong>${candidateName}</strong>,</p>
        <p>Sua candidatura para <strong>${jobTitle}</strong> na empresa <strong>${employerName}</strong> foi enviada.</p>
        <p><strong>Total enviado hoje:</strong> ${currentCount + 1} de ${DAILY_LIMIT}</p>
        <p>Qualquer resposta do empregador chegará diretamente no seu e-mail: <strong>${candidateEmail}</strong></p>
      </div>
    `

    await resend.emails.send({
      from: `Future EUA H2B <${FROM_EMAIL}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada - ${jobTitle}`,
      html: confirmationHtml,
    })

    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    return res.json({ 
      ok: true, 
      message: 'Candidatura enviada!',
      dailySent: newCount,
      dailyLimit: DAILY_LIMIT 
    })

  } catch (error) {
    console.error('❌ ERRO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend rodando na porta ${PORT}`)
  console.log(`📊 Controle diário ativo - Limite: ${DAILY_LIMIT}/dia`)
  console.log('═══════════════════════════════════════════')
})