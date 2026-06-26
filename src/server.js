import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import nodemailer from 'nodemailer'
import fs from 'fs/promises'
import path from 'path'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
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
    res.status(401).json({
      ok: false,
      error: 'Acesso administrativo negado.',
    })
    return false
  }

  return true
}

// ===================== FUNÇÃO PARA BAIXAR ARQUIVO DA URL =====================
async function downloadFileFromUrl(url) {
  try {
    if (!url || url === 'null' || url === 'undefined') return null

    console.log(`📥 Baixando arquivo: ${url.substring(0, 80)}...`)

    const response = await fetch(url)

    if (!response.ok) {
      console.warn(`⚠️ Falha ao baixar arquivo (status ${response.status}): ${url.substring(0, 80)}`)
      return null
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    console.log(`✅ Arquivo baixado: ${(buffer.length / 1024).toFixed(1)} KB`)

    return buffer
  } catch (error) {
    console.error(`❌ Erro ao baixar arquivo: ${error.message}`)
    return null
  }
}

// ===================== FUNÇÃO PARA PREPARAR ANEXOS =====================
async function prepareAttachments(attachments = []) {
  const prepared = []

  for (const att of attachments) {
    if (!att || !att.url) continue

    try {
      const buffer = await downloadFileFromUrl(att.url)

      if (buffer && buffer.length > 0) {
        // Detecta extensão do arquivo pela URL
        const urlPath = new URL(att.url).pathname
        const ext = urlPath.split('.').pop() || 'pdf'
        const filename = att.filename || `documento.${ext}`

        prepared.push({
          filename: filename,
          content: buffer,
          contentType: ext === 'pdf' ? 'application/pdf'
            : ext === 'doc' ? 'application/msword'
            : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream',
        })

        console.log(`📎 Anexo preparado: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`)
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

app.get('/api/admin/generate-key', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return

    const licenses = await readLicenses()
    let key = generatePremiumKey()

    while (licenses.some((license) => license.key === key)) {
      key = generatePremiumKey()
    }

    const email = req.query.email ? String(req.query.email).toLowerCase() : ''

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
      daysValid: 180,
    }

    licenses.push(license)
    await writeLicenses(licenses)

    return res.json({
      ok: true,
      key,
      license,
      message: 'Chave gerada com sucesso.',
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      ok: false,
      error: 'Erro ao gerar chave.',
    })
  }
})

app.get('/api/admin/licenses', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return

    const licenses = await readLicenses()
    return res.json({ ok: true, licenses })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'Erro ao listar chaves.',
    })
  }
})

app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body

    if (!key || !user?.email) {
      return res.status(400).json({
        ok: false,
        error: 'Chave e e-mail são obrigatórios.',
      })
    }

    const cleanedKey = cleanKey(key)
    const userEmail = String(user.email).trim().toLowerCase()

    const licenses = await readLicenses()
    const index = licenses.findIndex((license) => license.key === cleanedKey)

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: 'Chave inválida. Verifique e tente novamente.',
      })
    }

    const license = licenses[index]

    if (license.status === 'active') {
      if (license.assignedEmail !== userEmail) {
        return res.status(403).json({
          ok: false,
          error:
            'Esta chave já está vinculada a outro e-mail. Solicite sua própria chave Premium.',
        })
      }

      return res.json({
        ok: true,
        message: 'Chave já estava ativa para este e-mail.',
        userUpdate: {
          premium: true,
          accessKey: license.key,
          premiumActivatedAt: license.activatedAt,
          premiumExpiresAt: license.expiresAt,
          lockedProfile: license.lockedProfile,
          ...license.lockedProfile,
        },
        license,
      })
    }

    if (license.assignedEmail && license.assignedEmail !== userEmail) {
      return res.status(403).json({
        ok: false,
        error:
          'Esta chave foi gerada para outro e-mail. Confira o e-mail informado na compra.',
      })
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
      userUpdate: {
        premium: true,
        accessKey: cleanedKey,
        premiumActivatedAt: now.toISOString(),
        premiumExpiresAt: expiresAt.toISOString(),
        lockedProfile,
        ...lockedProfile,
      },
      license: licenses[index],
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      ok: false,
      error: 'Erro ao ativar chave.',
    })
  }
})

// ===================== ROTA PRINCIPAL: ENVIAR CANDIDATURA =====================
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
    console.log('📍 Local:', jobLocation)
    console.log('📋 Case Number:', caseNumber)
    console.log('📎 Anexos recebidos:', attachments?.length || 0)

    if (!candidateEmail || !jobTitle) {
      return res.status(400).json({
        ok: false,
        error: 'Dados obrigatórios faltando.',
      })
    }

    // ===== PREPARAR ANEXOS (baixar PDFs do Supabase Storage) =====
    let emailAttachments = []

    if (attachments && attachments.length > 0) {
      console.log('📥 Baixando anexos do Supabase Storage...')
      emailAttachments = await prepareAttachments(attachments)
      console.log(`✅ ${emailAttachments.length} anexo(s) prontos para envio`)
    } else {
      console.log('⚠️ Nenhum anexo recebido do frontend')
    }

    // ===== E-MAIL PARA O EMPREGADOR =====
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

    if (employerEmail && employerEmail !== 'Contato não informado') {
      console.log(`📤 Enviando e-mail para empregador: ${employerEmail}`)
      
      await transporter.sendMail({
        from: `"${candidateName} via FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
        to: employerEmail,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      
      console.log(`✅ E-mail enviado para empregador com ${emailAttachments.length} anexo(s)`)
    }

    // ===== E-MAIL PARA O CANDIDATO (cópia de confirmação) =====
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #16a34a; color: white; padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
          <h2 style="margin: 0;">✅ Candidatura enviada com sucesso!</h2>
          <p style="margin: 5px 0 0; opacity: 0.9;">FUTURE EUA H2B</p>
        </div>
        
        <div style="padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
          <p>Olá, <strong>${candidateName}</strong>!</p>
          <p>Sua candidatura foi enviada com sucesso para o empregador abaixo. Segue abaixo o resumo:</p>
          
          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #16a34a;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 6px 0; color: #666;">Vaga:</td><td style="padding: 6px 0;"><strong>${jobTitle}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #666;">Empregador:</td><td style="padding: 6px 0;"><strong>${employerName}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #666;">Local:</td><td style="padding: 6px 0;"><strong>${jobLocation || '—'}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #666;">Case Number:</td><td style="padding: 6px 0;"><strong>${caseNumber || '—'}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #666;">Data/Hora:</td><td style="padding: 6px 0;"><strong>${new Date().toLocaleString('pt-BR')}</strong></td></tr>
            </table>
          </div>
          
          <h3 style="color: #16a34a; margin-bottom: 12px;">📋 Seus dados enviados:</h3>
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
          <h3 style="color: #16a34a; margin-bottom: 12px;">📎 Documentos anexados:</h3>
          <ul style="padding-left: 20px;">
            ${emailAttachments.map(att => `<li style="padding: 4px 0;">✅ ${att.filename}</li>`).join('')}
          </ul>
          ` : '<p style="color: #f59e0b;">⚠️ Nenhum documento foi anexado a esta candidatura.</p>'}
          
          <p>Caso o empregador tenha interesse, ele entrará em contato diretamente com você.</p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px; text-align: center;">
            FUTURE EUA H2B — Rumo ao sonho americano 🇧🇷 → 🇺🇸
          </p>
        </div>
      </div>
    `

    console.log(`📤 Enviando e-mail de confirmação para candidato: ${candidateEmail}`)
    
    await transporter.sendMail({
      from: `"FUTURE EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada — ${jobTitle} at ${employerName}`,
      html: candidateHtml,
      attachments: emailAttachments,
    })
    
    console.log(`✅ E-mail de confirmação enviado para candidato com ${emailAttachments.length} anexo(s)`)
    console.log('═══════════════════════════════════════════')
    console.log('✅ CANDIDATURA PROCESSADA COM SUCESSO')
    console.log('═══════════════════════════════════════════')

    return res.json({
      ok: true,
      message: `E-mails enviados com sucesso! ${emailAttachments.length} anexo(s) incluídos.`,
    })
  } catch (error) {
    console.error('❌ Erro ao enviar e-mail:', error)

    return res.status(500).json({
      ok: false,
      error: error.message || 'Erro ao enviar e-mails.',
    })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend Future EUA H2B rodando em http://localhost:${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log('═══════════════════════════════════════════')
})