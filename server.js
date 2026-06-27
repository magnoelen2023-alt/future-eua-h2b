import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Resend } from 'resend' // Usando Resend em vez de Nodemailer
import fs from 'fs/promises'
import path from 'path'

const app = express()

// Configuração de CORS (permite o header do admin)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-secret']
}))
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'

// ===================== CONFIGURAÇÃO DO RESEND =====================
const resend = new Resend(process.env.RESEND_API_KEY)
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'

// ===================== ARQUIVO DE LICENÇAS =====================
const LICENSES_FILE = path.resolve('licenses.json')

async function ensureLicensesFile() {
  try {
    await fs.access(LICENSES_FILE)
  } catch {
    await fs.writeFile(LICENSES_FILE, JSON.stringify([], null, 2))
  }
}

async function readLicenses() {
  await ensureLicensesFile()
  const raw = await fs.readFile(LICENSES_FILE, 'utf-8')
  return JSON.parse(raw || '[]')
}

async function writeLicenses(licenses) {
  await fs.writeFile(LICENSES_FILE, JSON.stringify(licenses, null, 2))
}

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
  const secretFromHeader = req.headers['x-admin-secret']
  const secretFromQuery = req.query.secret
  const secretFromBody = req.body?.secret
  const received = secretFromHeader || secretFromQuery || secretFromBody

  if (received !== ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: 'Acesso administrativo negado.' })
    return false
  }
  return true
}

// ===================== FUNÇÕES DE DOWNLOAD E ANEXOS =====================
async function downloadFileFromUrl(url) {
  try {
    if (!url || url === 'null' || url === 'undefined') return null
    console.log(`📥 Baixando: ${url.substring(0, 70)}...`)
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`⚠️ Falha ao baixar (status ${response.status})`)
      return null
    }
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    console.log(`✅ Baixado: ${(buffer.length / 1024).toFixed(1)} KB`)
    return buffer
  } catch (error) {
    console.error(`❌ Erro ao baixar arquivo: ${error.message}`)
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
        const filename = att.filename || `documento.${ext}`
        prepared.push({ filename, content: buffer })
        console.log(`📎 Anexo pronto: ${filename}`)
      }
    } catch (error) {
      console.error(`❌ Erro ao preparar anexo: ${error.message}`)
    }
  }
  return prepared
}

// ===================== ROTAS =====================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend Future EUA H2B rodando!' })
})

// ROTA PARA GERAR KEY (ACESSO PELO CELULAR)
// Exemplo: https://SEU-LINK.onrender.com/api/admin/generate-key?secret=MAGNO-ADMIN-2026&email=cliente@email.com
app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return

  try {
    const licenses = await readLicenses()
    let key = generatePremiumKey()

    while (licenses.some((license) => license.key === key)) {
      key = generatePremiumKey()
    }

    const email = req.query.email ? String(req.query.email).toLowerCase() : ''
    const days = parseInt(req.query.days) || 180

    const license = {
      key,
      status: 'unused',
      assignedEmail: email,
      lockedProfile: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      expiresAt: null,
      maxDaily: 100,
      maxSeason: 3500,
      daysValid: days,
    }

    licenses.push(license)
    await writeLicenses(licenses)

    console.log(`🔑 KEY GERADA: ${key} para ${email || 'N/A'}`)

    return res.json({
      ok: true,
      key,
      license,
      message: 'Chave gerada com sucesso.',
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ ok: false, error: 'Erro ao gerar chave.' })
  }
})

app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const licenses = await readLicenses()
    return res.json({ ok: true, licenses })
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Erro ao listar chaves.' })
  }
})

app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body
    if (!key || !user?.email) {
      return res.status(400).json({ ok: false, error: 'Chave e e-mail são obrigatórios.' })
    }

    const cleanedKey = cleanKey(key)
    const userEmail = String(user.email).trim().toLowerCase()
    const licenses = await readLicenses()
    const index = licenses.findIndex((license) => license.key === cleanedKey)

    if (index === -1) {
      return res.status(404).json({ ok: false, error: 'Chave inválida. Verifique e tente novamente.' })
    }

    const license = licenses[index]

    if (license.status === 'active') {
      if (license.assignedEmail !== userEmail) {
        return res.status(403).json({ ok: false, error: 'Esta chave já está vinculada a outro e-mail.' })
      }
      return res.json({ ok: true, message: 'Chave já estava ativa.', userUpdate: { premium: true, ...license.lockedProfile }, license })
    }

    if (license.assignedEmail && license.assignedEmail !== userEmail) {
      return res.status(403).json({ ok: false, error: 'Esta chave foi gerada para outro e-mail.' })
    }

    const now = new Date()
    const expiresAt = addDays(now, license.daysValid || 180)
    const lockedProfile = normalizeLockedProfile(user)

    licenses[index] = {
      ...license,
      status: 'active',
      assignedEmail: userEmail,
      lockedProfile,
      activatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }

    await writeLicenses(licenses)

    return res.json({
      ok: true,
      message: 'Chave Premium ativada com sucesso.',
      userUpdate: { premium: true, accessKey: cleanedKey, premiumActivatedAt: now.toISOString(), premiumExpiresAt: expiresAt.toISOString(), lockedProfile, ...lockedProfile },
      license: licenses[index],
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ ok: false, error: 'Erro ao ativar chave.' })
  }
})

// ===================== ROTA PRINCIPAL: ENVIAR CANDIDATURA =====================
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
      console.log('📥 Baixando anexos...')
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
        from: `"${candidateName} via FUTURE EUA H2B" <${FROM_EMAIL}>`,
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
      from: `"FUTURE EUA H2B" <${FROM_EMAIL}>`,
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
  console.log('═══════════════════════════════════════════')
})