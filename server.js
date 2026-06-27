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
  res.json({ ok: true, message: 'Backend Future EUA H2B rodando!' })
})

// GERAR KEY (acesse pelo celular)
app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const email = req.query.email ? String(req.query.email).toLowerCase() : ''
    const days = parseInt(req.query.days) || 180
    const key = generatePremiumKey()

    const { data, error } = await supabase
      .from('licenses')
      .insert([{
        key,
        status: 'unused',
        assigned_email: email,
        days_valid: days,
        max_daily: 100,
        max_season: 3500,
      }])
      .select()
      .single()

    if (error) {
      console.error('Erro Supabase:', error)
      return res.status(500).json({ ok: false, error: error.message })
    }

    console.log(`🔑 KEY GERADA: ${key} para ${email}`)
    return res.json({
      ok: true,
      key,
      license: data,
      message: 'Chave gerada com sucesso.',
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// LISTAR KEYS
app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const { data, error } = await supabase
      .from('licenses')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, licenses: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// ATIVAR KEY
app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body
    if (!key || !user?.email) {
      return res.status(400).json({ ok: false, error: 'Chave e e-mail são obrigatórios.' })
    }

    const cleanedKey = cleanKey(key)
    const userEmail = String(user.email).trim().toLowerCase()

    const { data: license, error: findError } = await supabase
      .from('licenses')
      .select('*')
      .eq('key', cleanedKey)
      .single()

    if (findError || !license) {
      return res.status(404).json({ ok: false, error: 'Chave inválida. Verifique e tente novamente.' })
    }

    // Já ativa
    if (license.status === 'active') {
      if (license.assigned_email !== userEmail) {
        return res.status(403).json({ ok: false, error: 'Esta chave já está vinculada a outro e-mail.' })
      }
      return res.json({
        ok: true,
        message: 'Chave já estava ativa para este e-mail.',
        userUpdate: {
          premium: true,
          accessKey: license.key,
          premiumActivatedAt: license.activated_at,
          premiumExpiresAt: license.expires_at,
          lockedProfile: license.locked_profile,
          ...license.locked_profile,
        },
        license,
      })
    }

    // Vinculada a outro email
    if (license.assigned_email && license.assigned_email !== userEmail) {
      return res.status(403).json({ ok: false, error: 'Esta chave foi gerada para outro e-mail.' })
    }

    const now = new Date()
    const expiresAt = addDays(now, license.days_valid || 180)
    const lockedProfile = normalizeLockedProfile(user)

    const { data: updated, error: updateError } = await supabase
      .from('licenses')
      .update({
        status: 'active',
        assigned_email: userEmail,
        locked_profile: lockedProfile,
        activated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq('key', cleanedKey)
      .select()
      .single()

    if (updateError) {
      return res.status(500).json({ ok: false, error: updateError.message })
    }

    return res.json({
      ok: true,
      message: 'Chave Premium ativada com sucesso.',
      userUpdate: {
        premium: true,
        accessKey: cleanedKey,
        premiumActivatedAt: now.toISOString(),
        premiumExpiresAt: expiresAt.toISOString(),
        lockedProfile,
        ...lockedProfile,
      },
      license: updated,
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// ===================== ENVIAR CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments,
    } = req.body

    console.log('📨 NOVA CANDIDATURA:', candidateName, jobTitle)

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })
    }

    let emailAttachments = []
    if (attachments && attachments.length > 0) {
      emailAttachments = await prepareAttachments(attachments)
    }

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #1a3a8f; color: white; padding: 20px; text-align: center;">
          <h2>Job Application — ${jobTitle}</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <p>${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
          <h3>Candidate:</h3>
          <p><strong>${candidateName}</strong> (${candidateEmail} / ${candidatePhone || 'N/A'})</p>
          <p><strong>Position:</strong> ${jobTitle} at ${jobLocation || 'N/A'}</p>
          <p><strong>Case #:</strong> ${caseNumber || 'N/A'}</p>
        </div>
      </div>
    `

    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail

    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      await resend.emails.send({
        from: `${candidateName} via FUTURE EUA H2B <${FROM_EMAIL}>`,
        to: [employerTargetEmail],
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      })
      console.log(`✅ Email enviado para: ${employerTargetEmail}`)
    }

    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto;">
        <h2>✅ Candidatura enviada!</h2>
        <p>Olá ${candidateName}, sua candidatura para ${jobTitle} foi enviada com sucesso.</p>
      </div>
    `

    await resend.emails.send({
      from: `FUTURE EUA H2B <${FROM_EMAIL}>`,
      to: [candidateEmail],
      subject: `✅ Candidatura enviada — ${jobTitle}`,
      html: candidateHtml,
      attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
    })
    console.log(`✅ Confirmação enviada para: ${candidateEmail}`)

    return res.json({ ok: true, message: 'E-mails enviados com sucesso!' })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend rodando na porta ${PORT}`)
  console.log(`📧 Resend From: ${FROM_EMAIL}`)
  console.log(`🗄️ Supabase: ${process.env.SUPABASE_URL ? 'Conectado' : 'NÃO CONFIGURADO'}`)
  console.log('═══════════════════════════════════════════')
})