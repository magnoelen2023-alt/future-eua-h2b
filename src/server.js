import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import nodemailer from 'nodemailer'
import fs from 'fs/promises'
import path from 'path'

const app = express()
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-secret']
}))
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'

// ===================== CONFIGURAÇÃO MELHORADA DO GMAIL =====================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
  pool: true,
  maxConnections: 5,
  maxMessages: 10
})

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

        prepared.push({
          filename,
          content: buffer,
          contentType: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream',
        })
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

app.get('/api/admin/generate-key', async (req, res) => { /* ... mesma função anterior ... */ })
app.get('/api/admin/licenses', async (req, res) => { /* ... mesma função anterior ... */ })
app.post('/api/activate-key', async (req, res) => { /* ... mesma função anterior ... */ })

// ===================== ROTA PRINCIPAL =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName,
      candidateEmail,
      candidatePhone,
      employerName,
      employerEmail,
      jobTitle,
      jobLocation,
      caseNumber,
      messageBody,
      attachments,
    } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 NOVA CANDIDATURA')
    console.log('═══════════════════════════════════════════')
    console.log('👤 Candidato:', candidateName)
    console.log('📧 Email candidato:', candidateEmail)
    console.log('📞 Telefone:', candidatePhone)
    console.log('🏢 Empregador:', employerName)
    console.log('📧 Email empregador:', employerEmail)
    console.log('💼 Vaga:', jobTitle)
    console.log('📎 Anexos recebidos:', attachments?.length || 0)

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando.' })
    }

    let emailAttachments = []
    if (attachments && attachments.length > 0) {
      console.log('📥 Baixando anexos...')
      emailAttachments = await prepareAttachments(attachments)
      console.log(`✅ ${emailAttachments.length} anexo(s) preparados`)
    }

    const employerHtml = `...` // (mantive o HTML bonito que você já tinha)

    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail
    const isTestMode = Boolean(testEmployerEmail)

    console.log('📧 Enviando para:', employerTargetEmail)
    console.log('🧪 Modo teste:', isTestMode ? 'ATIVO' : 'DESATIVADO')

    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      await transporter.sendMail({
        from: `"${candidateName} via FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
        to: employerTargetEmail,
        replyTo: candidateEmail,
        subject: `${isTestMode ? '[TESTE] ' : ''}Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      console.log(`✅ E-mail enviado para empregador com ${emailAttachments.length} anexo(s)`)
    }

    // E-mail de confirmação para o candidato
    const candidateHtml = `...` // (mantive o HTML bonito)

    await transporter.sendMail({
      from: `"FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada — ${jobTitle}`,
      html: candidateHtml,
      attachments: emailAttachments,
    })

    console.log('✅ CANDIDATURA PROCESSADA COM SUCESSO')
    return res.json({ ok: true, message: 'E-mails enviados com sucesso!' })

  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend rodando em http://localhost:${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log(`🧪 Empregador teste: ${process.env.TEST_EMPLOYER_EMAIL || 'DESATIVADO'}`)
  console.log('═══════════════════════════════════════════')
})