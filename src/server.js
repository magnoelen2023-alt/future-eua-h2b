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

// Detetive de variáveis de ambiente
console.log('🔍 CHECK ENV VARIABLES:')
console.log('GMAIL_USER:', process.env.GMAIL_USER ? 'CONFIGURADO ✅' : 'NÃO ENCONTRADO ❌')
console.log('GMAIL_PASS:', process.env.GMAIL_PASS ? 'CONFIGURADO ✅' : 'NÃO ENCONTRADO ❌')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
  // FORÇAR IPv4 (SOLUÇÃO DO ERRO ENETUNREACH)
  connectionTimeout: 10000,
  socketTimeout: 10000,
  tls: {
    rejectUnauthorized: true
  }
})

// ===================== FUNÇÕES DE APOIO =====================
async function downloadFileFromUrl(url) {
  try {
    if (!url) return null
    const response = await fetch(url)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error('Erro ao baixar arquivo:', error.message)
    return null
  }
}

async function prepareAttachments(attachments = []) {
  const prepared = []
  for (const att of attachments) {
    if (!att?.url) continue
    const buffer = await downloadFileFromUrl(att.url)
    if (buffer) {
      const ext = att.url.split('.').pop() || 'pdf'
      prepared.push({
        filename: att.filename || `documento.${ext}`,
        content: buffer,
        contentType: ext === 'pdf' ? 'application/pdf' : 'application/octet-stream'
      })
    }
  }
  return prepared
}

// ===================== ROTAS =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend Future EUA H2B rodando!' })
})

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
      attachments = []
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
    console.log('📎 Anexos recebidos:', attachments.length)

    const emailAttachments = await prepareAttachments(attachments)
    console.log(`✅ ${emailAttachments.length} anexo(s) prontos`)

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <h2 style="color: #1a3a8f;">Job Application — ${jobTitle}</h2>
        <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
        <p style="white-space: pre-line;">${messageBody}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p><strong>Position:</strong> ${jobTitle}</p>
        <p><strong>Location:</strong> ${jobLocation || '—'}</p>
        <p><strong>Case Number:</strong> ${caseNumber || '—'}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p><strong>Candidate:</strong> ${candidateName}</p>
        <p><strong>Email:</strong> ${candidateEmail}</p>
        <p><strong>Phone:</strong> ${candidatePhone || '—'}</p>
        <br />
        <p>Best regards,<br />${candidateName}</p>
      </div>
    `

    // NOTIFICAÇÃO 1: ENVIO PARA O EMPREGADOR
    if (employerEmail && employerEmail.includes('@')) {
      console.log(`📤 Enviando para empregador: ${employerEmail}`)
      
      const info = await transporter.sendMail({
        from: `"${candidateName}" <${process.env.GMAIL_USER}>`,
        to: employerEmail,
        replyTo: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments,
      })
      
      console.log(`✅ E-mail enviado! Message ID: ${info.messageId}`)
    }

    // NOTIFICAÇÃO 2: CONFIRMAÇÃO PARA O CANDIDATO
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <h2 style="color: #16a34a;">✅ Candidatura enviada com sucesso!</h2>
        <p>Olá, <strong>${candidateName}</strong>!</p>
        <p>Sua candidatura para <strong>${jobTitle}</strong> foi enviada para <strong>${employerName}</strong>.</p>
        <p>Se o empregador tiver resposta automática, ela chegará em breve.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #888; font-size: 13px;">FUTURE EUA H2B — Bymagno_rust</p>
      </div>
    `

    await transporter.sendMail({
      from: `"Future EUA H2B" <${process.env.GMAIL_USER}>`,
      to: candidateEmail,
      subject: `✅ Candidatura confirmada — ${jobTitle}`,
      html: candidateHtml,
    })
    
    console.log('✅ Candidatura processada com sucesso!')

    return res.json({ ok: true, message: 'Emails enviados!' })

  } catch (error) {
    console.error('❌ Erro ao enviar e-mail:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend Future EUA H2B rodando em http://localhost:${PORT}`)
  console.log(`📧 Gmail: ${process.env.GMAIL_USER}`)
  console.log('═══════════════════════════════════════════')
})