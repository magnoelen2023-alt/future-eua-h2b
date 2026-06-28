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
  const { data } = await supabase
    .from('daily_sends')
    .select('count')
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .maybeSingle()
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
  res.json({ ok: true, message: 'Backend v5 - Teste com Gmail SMTP' })
})

// ===================== ENVIO DE CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey
    } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 NOVA CANDIDATURA RECEBIDA')
    console.log('👤 Candidato:', candidateName)
    console.log('📧 Email candidato:', candidateEmail)
    console.log('🏢 Empregador:', employerName)
    console.log('📧 Email empregador:', employerEmail)
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

    // ===================== E-MAIL PARA O EMPREGADOR =====================
    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #222;">
        <div style="background: #1a3a8f; color: white; padding: 25px; text-align: center;">
          <h2 style="margin: 0;">Nova Candidatura Recebida</h2>
          <p style="margin: 8px 0 0; opacity: 0.9;">H-2B Visa Seasonal Program</p>
        </div>
        <div style="padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <p>${messageBody || 'I am writing to express my strong interest in the seasonal position available at your company. I am available and ready to work.'}</p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          
          <h3 style="color: #1a3a8f;">Candidate Information</h3>
          <p><strong>Name:</strong> ${candidateName}</p>
          <p><strong>Email:</strong> ${candidateEmail}</p>
          <p><strong>Phone:</strong> ${candidatePhone || 'Not provided'}</p>
          <p><strong>Position:</strong> ${jobTitle}</p>
          <p><strong>Location:</strong> ${jobLocation || 'Not informed'}</p>
          
          ${emailAttachments.length > 0 ? `
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <h3 style="color: #1a3a8f;">Attached Documents</h3>
          <ul>${emailAttachments.map(a => `<li>${a.filename}</li>`).join('')}</ul>` : ''}
          
          <p style="margin-top: 30px; color: #555;">Sincerely,<br><strong>${candidateName}</strong></p>
        </div>
      </div>
    `

    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      await transporter.sendMail({
        from: `"${candidateName}" <${process.env.GMAIL_USER}>`,
        to: employerTargetEmail,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      console.log(`✅ E-mail enviado para empregador: ${employerTargetEmail}`)
    }

    // ===================== CONFIRMAÇÃO PARA O CANDIDATO =====================
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto;">
        <div style="background: #16a34a; color: white; padding: 25px; text-align: center;">
          <h2 style="margin: 0;">✅ Candidatura Enviada com Sucesso!</h2>
        </div>
        <div style="padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
          <p>Olá <strong>${candidateName}</strong>,</p>
          <p>Sua candidatura para a vaga de <strong>${jobTitle}</strong> na empresa <strong>${employerName}</strong> foi enviada com sucesso.</p>
          
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Envios hoje:</strong> ${currentCount + 1} de ${DAILY_LIMIT}</p>
            <p><strong>Destinatário:</strong> ${employerTargetEmail}</p>
          </div>

          <p><strong>Importante:</strong> Qualquer resposta (automática ou manual) do empregador chegará diretamente na sua caixa de entrada.</p>
          
          <p style="color: #555; margin-top: 30px;">Atenciosamente,<br>Equipe Future EUA H2B</p>
        </div>
      </div>
    `

    await transporter.sendMail({
      from: `"Future EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada — ${jobTitle}`,
      html: candidateHtml,
      attachments: emailAttachments,
    })
    console.log(`✅ Confirmação enviada para o candidato: ${candidateEmail}`)

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
  console.log(`📧 Enviando de: ${process.env.GMAIL_USER}`)
  console.log(`🧪 TEST_EMPLOYER_EMAIL: ${process.env.TEST_EMPLOYER_EMAIL || 'DESATIVADO'}`)
  console.log(`📊 Limite diário: ${DAILY_LIMIT} por usuário`)
  console.log('═══════════════════════════════════════════')
})