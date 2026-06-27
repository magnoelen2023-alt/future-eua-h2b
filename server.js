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

// GERAR KEY
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
      .select().single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// LISTAR KEYS
app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { data, error } = await supabase
      .from('licenses').select('*').order('created_at', { ascending: false })
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

// ===================== ROTA PRINCIPAL: ENVIAR CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments,
    } = req.body

    console.log(`📨 PROCESSANDO: ${candidateName} -> ${employerName}`)

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })
    }

    let emailAttachments = await prepareAttachments(attachments)

    // 1. HTML PARA O EMPREGADOR
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
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail

    // ENVIAR PARA EMPREGADOR
    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      await resend.emails.send({
        from: `${candidateName} <${FROM_EMAIL}>`,
        to: [employerTargetEmail],
        reply_to: candidateEmail, // <--- RESPOSTAS VÃO PARA O CLIENTE
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      })
      console.log(`✅ Enviado ao empregador. Respostas para: ${candidateEmail}`)
    }

    // 2. HTML PARA O CLIENTE (CONFIRMAÇÃO)
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
            <p style="margin: 5px 0 0;"><strong>Data:</strong> ${new Date().toLocaleString('pt-BR')}</p>
          </div>

          <p><strong>O que acontece agora?</strong></p>
          <p>Se o empregador responder ao seu e-mail ou tiver uma resposta automática de recebimento, ela chegará <strong>diretamente na sua caixa de entrada</strong> em <em>${candidateEmail}</em>.</p>
          
          <p style="color: #666; font-size: 13px; margin-top: 30px;">
            Atenciosamente,<br>Equipe Future EUA H2B
          </p>
        </div>
      </div>
    `

    await resend.emails.send({
      from: `Future EUA H2B <${FROM_EMAIL}>`,
      to: [candidateEmail],
      subject: `✅ Candidatura Enviada: ${jobTitle} na empresa ${employerName}`,
      html: candidateHtml,
    })
    console.log(`✅ Confirmação enviada para o cliente: ${candidateEmail}`)

    return res.json({ ok: true, message: 'E-mails enviados com sucesso!' })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Servidor online na porta ${PORT}`)
  console.log('═══════════════════════════════════════════')
})