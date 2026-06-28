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

  // Busca registro atual
  const { data: existing } = await supabase
    .from('daily_sends')
    .select('id, count')
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .maybeSingle()

  if (existing) {
    // Atualiza count manualmente (sem supabase.raw)
    const newCount = (existing.count || 0) + 1
    const { data: updated } = await supabase
      .from('daily_sends')
      .update({ count: newCount })
      .eq('id', existing.id)
      .select()
      .single()
    return updated?.count || newCount
  }

  // Cria novo registro
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
function generateBlock(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < length; i++) {
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

// ===================== DOWNLOAD ANEXOS =====================
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

// ===================== ROTAS ADMIN =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend v4 - Gmail SMTP + Limite 500/dia por usuário' })
})

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
        max_daily: 500,
        max_season: 3500
      }])
      .select()
      .single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { data } = await supabase
    .from('licenses')
    .select('*')
    .order('created_at', { ascending: false })
  return res.json({ ok: true, licenses: data })
})

app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body
    if (!key || !user?.email) {
      return res.status(400).json({ ok: false, error: 'Dados faltantes.' })
    }
    const cleanedKey = cleanKey(key)
    const userEmail = user.email.trim().toLowerCase()

    const { data: license, error: findError } = await supabase
      .from('licenses')
      .select('*')
      .eq('key', cleanedKey)
      .single()

    if (findError || !license) {
      return res.status(404).json({ ok: false, error: 'Chave inválida.' })
    }

    if (license.status === 'active') {
      if (license.assigned_email !== userEmail) {
        return res.status(403).json({ ok: false, error: 'Chave de outro usuário.' })
      }
      return res.json({
        ok: true,
        message: 'Chave já ativa.',
        userUpdate: {
          premium: true,
          accessKey: license.key,
          premiumActivatedAt: license.activated_at,
          premiumExpiresAt: license.expires_at,
        },
        license
      })
    }

    if (license.assigned_email && license.assigned_email !== userEmail) {
      return res.status(403).json({ ok: false, error: 'Chave vinculada a outro e-mail.' })
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
        expires_at: expiresAt.toISOString()
      })
      .eq('key', cleanedKey)
      .select()
      .single()

    if (updateError) return res.status(500).json({ ok: false, error: updateError.message })

    return res.json({
      ok: true,
      message: 'Chave ativada com sucesso!',
      userUpdate: {
        premium: true,
        accessKey: cleanedKey,
        premiumActivatedAt: now.toISOString(),
        premiumExpiresAt: expiresAt.toISOString(),
        lockedProfile,
        ...lockedProfile,
      },
      license: updated
    })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/daily-stats', async (req, res) => {
  const { licenseKey } = req.query
  if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey obrigatório' })
  const count = await getDailyCount(licenseKey)
  res.json({
    ok: true,
    dailySent: count,
    dailyLimit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - count)
  })
})

// ===================== ENVIO DE CANDIDATURA =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone,
      employerName, employerEmail, jobTitle, jobLocation,
      caseNumber, messageBody, attachments, licenseKey
    } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 PROCESSANDO CANDIDATURA')
    console.log('👤 Cliente:', candidateName)
    console.log('📧 Email:', candidateEmail)
    console.log('🏢 Empregador:', employerName)
    console.log('💼 Vaga:', jobTitle)
    console.log('🔑 LicenseKey:', licenseKey)
    console.log('═══════════════════════════════════════════')

    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: 'LicenseKey não informada.' })
    }

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })
    }

    const currentCount = await getDailyCount(licenseKey)
    console.log('📊 Envios hoje:', currentCount, '/', DAILY_LIMIT)

    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({
        ok: false,
        error: `Limite diário de ${DAILY_LIMIT} envios atingido.`
      })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    // ===================== E-MAIL DO EMPREGADOR =====================
    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #1a3a8f; color: white; padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
          <h2 style="margin: 0;">Job Application — ${jobTitle}</h2>
          <p style="margin: 5px 0 0; opacity: 0.9;">H-2B Visa Seasonal Program</p>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #1a3a8f;">
            <p style="margin: 0; white-space: pre-line;">${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
          </div>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <h3 style="color: #1a3a8f; margin-bottom: 12px;">📋 Position Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; color: #666;">Position:</td><td style="padding: 6px 0;"><strong>${jobTitle}</strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Location:</td><td style="padding: 6px 0;"><strong>${jobLocation || '—'}</strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Case Number:</td><td style="padding: 6px 0;"><strong>${caseNumber || '—'}</strong></td></tr>
          </table>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <h3 style="color: #1a3a8f; margin-bottom: 12px;">👤 Candidate Information</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; color: #666;">Name:</td><td style="padding: 6px 0;"><strong>${candidateName}</strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Email:</td><td style="padding: 6px 0;"><strong><a href="mailto:${candidateEmail}" style="color: #1a3a8f;">${candidateEmail}</a></strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Phone:</td><td style="padding: 6px 0;"><strong>${candidatePhone || '—'}</strong></td></tr>
          </table>
          ${emailAttachments.length > 0 ? `
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <h3 style="color: #1a3a8f; margin-bottom: 12px;">📎 Attached Documents</h3>
          <ul style="padding-left: 20px;">
            ${emailAttachments.map(att => `<li style="padding: 4px 0;">${att.filename}</li>`).join('')}
          </ul>
          ` : ''}
          <br />
          <p>Sincerely,<br /><strong>${candidateName}</strong></p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            Sent via FUTURE EUA H2B Platform — H-2B Visa Seasonal Employment
          </p>
        </div>
      </div>
    `

    let employerEmailSent = false
    if (employerTargetEmail && employerTargetEmail !== 'Contato não informado' && employerTargetEmail.includes('@')) {
      try {
        await transporter.sendMail({
          from: `"${candidateName} via FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
          to: employerTargetEmail,
          replyTo: candidateEmail,
          subject: `Application: ${candidateName} — ${jobTitle}`,
          html: employerHtml,
          attachments: emailAttachments,
        })
        employerEmailSent = true
        console.log(`✅ E-mail enviado para empregador: ${employerTargetEmail}`)
      } catch (err) {
        console.error('❌ Erro ao enviar para empregador:', err.message)
      }
    }

    // ===================== CONFIRMAÇÃO PARA O CLIENTE =====================
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #16a34a; color: white; padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
          <h2 style="margin: 0;">✅ Candidatura Enviada!</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
          <p>Olá, <strong>${candidateName}</strong>,</p>
          <p>Confirmamos que sua candidatura para a vaga <strong>${jobTitle}</strong> foi enviada com sucesso para <strong>${employerName}</strong>.</p>
          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #16a34a;">
            <p style="margin: 0;"><strong>Vaga:</strong> ${jobTitle}</p>
            <p style="margin: 6px 0 0;"><strong>Empregador:</strong> ${employerName}</p>
            <p style="margin: 6px 0 0;"><strong>Local:</strong> ${jobLocation || '—'}</p>
            <p style="margin: 6px 0 0;"><strong>Case #:</strong> ${caseNumber || '—'}</p>
            <p style="margin: 6px 0 0;"><strong>Enviado em:</strong> ${new Date().toLocaleString('pt-BR')}</p>
            <p style="margin: 6px 0 0;"><strong>Envios hoje:</strong> ${currentCount + 1} de ${DAILY_LIMIT}</p>
          </div>
          <h3 style="color: #1a3a8f;">📋 Seus dados enviados:</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; color: #666;">Nome:</td><td style="padding: 6px 0;"><strong>${candidateName}</strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Email:</td><td style="padding: 6px 0;"><strong>${candidateEmail}</strong></td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Telefone:</td><td style="padding: 6px 0;"><strong>${candidatePhone || '—'}</strong></td></tr>
          </table>
          <div style="background: #f8f9fa; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <strong>Mensagem enviada ao empregador:</strong>
            <p style="white-space: pre-line; margin-top: 8px;">${messageBody || '—'}</p>
          </div>
          ${emailAttachments.length > 0 ? `
          <h3 style="color: #16a34a;">📎 Documentos anexados:</h3>
          <ul style="padding-left: 20px;">
            ${emailAttachments.map(att => `<li style="padding: 4px 0;">✅ ${att.filename}</li>`).join('')}
          </ul>
          ` : ''}
          <p style="margin-top: 16px;">
            <strong>Se o empregador responder, a mensagem chegará diretamente no seu e-mail:</strong>
            <br /><a href="mailto:${candidateEmail}" style="color: #1a3a8f;">${candidateEmail}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            FUTURE EUA H2B — Rumo ao sonho americano 🇧🇷 → 🇺🇸
          </p>
        </div>
      </div>
    `

    let candidateEmailSent = false
    try {
      await transporter.sendMail({
        from: `"FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
        to: candidateEmail,
        subject: `✅ Candidatura enviada — ${jobTitle} at ${employerName}`,
        html: candidateHtml,
        attachments: emailAttachments,
      })
      candidateEmailSent = true
      console.log(`✅ Confirmação enviada para: ${candidateEmail}`)
    } catch (err) {
      console.error('❌ Erro confirmação:', err.message)
    }

    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    console.log('═══════════════════════════════════════════')
    console.log('✅ PROCESSO FINALIZADO')
    console.log('📧 Empregador:', employerEmailSent)
    console.log('📧 Cliente:', candidateEmailSent)
    console.log('📊 Envios hoje:', newCount, '/', DAILY_LIMIT)
    console.log('═══════════════════════════════════════════')

    return res.json({
      ok: true,
      message: 'Candidatura enviada com sucesso!',
      dailySent: newCount,
      dailyLimit: DAILY_LIMIT,
      remaining: DAILY_LIMIT - newCount,
      employerEmailSent,
      candidateEmailSent,
    })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend v4 rodando na porta ${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log(`📊 Limite: ${DAILY_LIMIT} envios/dia POR USUÁRIO`)
  console.log(`🧪 Teste: ${process.env.TEST_EMPLOYER_EMAIL || 'DESATIVADO'}`)
  console.log('═══════════════════════════════════════════')
})