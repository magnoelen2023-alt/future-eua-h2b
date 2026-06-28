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

// ===================== RESEND & SUPABASE =====================
const resend = new Resend(process.env.RESEND_API_KEY)
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ===================== FUNÇÕES DE CONTROLE DIÁRIO =====================
async function getDailyCount(licenseKey) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]
  try {
    const { data } = await supabase
      .from('daily_sends')
      .select('count')
      .eq('license_key', licenseKey)
      .eq('send_date', today)
      .maybeSingle()
    return data?.count || 0
  } catch (error) {
    console.error("Aviso: Falha ao ler daily count:", error.message)
    return 0
  }
}

async function incrementDailyCount(licenseKey, userEmail, currentCount) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]
  const newCount = currentCount + 1
  
  try {
    const { error } = await supabase
      .from('daily_sends')
      .upsert({
        license_key: licenseKey,
        user_email: userEmail,
        send_date: today,
        count: newCount
      }, {
        onConflict: 'license_key,send_date'
      })
      
    if (error) console.error('Aviso: Erro ao incrementar limite:', error.message)
    return newCount
  } catch (error) {
    console.error("Aviso: Falha catastrofica ao incrementar:", error.message)
    return newCount
  }
}

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

async function prepareAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments)) return []
  const prepared = []
  for (const att of attachments) {
    if (!att || !att.url) continue
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
      console.error(`❌ Erro ao preparar anexo: ${error.message}`)
    }
  }
  return prepared
}

// ===================== ROTAS DE API =====================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend v3 - Fila protegida' })
})

app.get('/api/daily-stats', async (req, res) => {
  const { licenseKey } = req.query
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey é obrigatório' })
  
  const count = await getDailyCount(licenseKey)
  res.json({ 
    ok: true, 
    dailySent: count, 
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - count)
  })
})

app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const email = req.query.email ? String(req.query.email).toLowerCase() : ''
    const days = parseInt(req.query.days) || 180
    const key = generatePremiumKey()
    const { data, error } = await supabase
      .from('licenses')
      .insert([{
        key, status: 'unused', assigned_email: email, days_valid: days, max_daily: DAILY_LIMIT, max_season: 3500,
      }])
      .select().single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { data, error } = await supabase.from('licenses').select('*').order('created_at', { ascending: false })
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, licenses: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

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
      status: 'active', assigned_email: userEmail, locked_profile: normalizeLockedProfile(user), activated_at: now.toISOString(), expires_at: expiresAt.toISOString()
    }).eq('key', cleanedKey).select().single()

    if (updateError) return res.status(500).json({ ok: false, error: updateError.message })
    return res.json({ ok: true, license: updated })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// ===================== ROTA PRINCIPAL DE ENVIO =====================

app.post('/api/send-candidature', async (req, res) => {
  try {
    const { 
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail, 
      jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey 
    } = req.body

    console.log(`📨 PROCESSANDO: ${candidateName} -> ${employerName}`)

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })
    }

    // Validação de limite diário
    let currentCount = 0
    if (licenseKey) {
      currentCount = await getDailyCount(licenseKey)
      if (currentCount >= DAILY_LIMIT) {
        return res.status(429).json({ ok: false, error: `Limite diário de ${DAILY_LIMIT} envios atingido.` })
      }
    }

    const safeAttachments = Array.isArray(attachments) ? attachments : []
    let emailAttachments = []
    
    if (safeAttachments.length > 0) {
      emailAttachments = await prepareAttachments(safeAttachments)
    }

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
        <p>${messageBody || 'I am writing to express my interest in the seasonal position available at your company.'}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
        <p><strong>Candidate Details:</strong></p>
        <ul>
          <li><strong>Name:</strong> ${candidateName}</li>
          <li><strong>Email:</strong> ${candidateEmail}</li>
          <li><strong>Phone:</strong> ${candidatePhone || 'Not provided'}</li>
          <li><strong>Position:</strong> ${jobTitle}</li>
        </ul>
        <p style="font-size:11px; color:#999;">Sent via Future EUA H2B Platform</p>
      </div>
    `

    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const targetEmail = testEmployerEmail || rawEmployerEmail

    // ENVIO EMPREGADOR
    if (targetEmail && targetEmail.includes('@')) {
      await resend.emails.send({
        from: `${candidateName} <${FROM_EMAIL}>`,
        to: [targetEmail],
        reply_to: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      })
    }

    // ENVIO CANDIDATO (CONFIRMAÇÃO)
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background: #1a3a8f; color: white; padding: 20px; text-align: center;">
          <h2 style="margin: 0;">Candidatura Enviada!</h2>
        </div>
        <div style="padding: 20px;">
          <p>Olá <strong>${candidateName}</strong>,</p>
          <p>Confirmamos que sua candidatura para a vaga <strong>${jobTitle}</strong> foi enviada com sucesso para <strong>${employerName}</strong>.</p>
          <div style="background: #f4f7ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Destinatário:</strong> ${rawEmployerEmail}</p>
          </div>
          <p>Se o empregador responder, a mensagem chegará <strong>diretamente na sua caixa de entrada</strong> em <em>${candidateEmail}</em>.</p>
          <p style="color: #666; font-size: 13px; margin-top: 30px;">Atenciosamente,<br>Equipe Future EUA H2B</p>
        </div>
      </div>
    `

    await resend.emails.send({
      from: `Future EUA H2B <${FROM_EMAIL}>`,
      to: [candidateEmail],
      subject: `✅ Candidatura Enviada: ${jobTitle} na empresa ${employerName}`,
      html: candidateHtml,
    })

    console.log(`✅ E-mails disparados com sucesso!`)

    // Incrementa limite diário (PROTEGIDO COM TRY/CATCH)
    let newCount = currentCount
    if (licenseKey) {
      newCount = await incrementDailyCount(licenseKey, candidateEmail, currentCount)
    }

    // Sempre retorna 200 OK se chegou até aqui
    return res.json({ 
      ok: true, 
      message: 'E-mails enviados com sucesso!',
      dailySent: newCount,
      remaining: Math.max(0, DAILY_LIMIT - newCount)
    })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO NO ENVIO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Servidor online na porta ${PORT}`)
  console.log(`📧 Resend Email: ${FROM_EMAIL}`)
  console.log('═══════════════════════════════════════════')
})