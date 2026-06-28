import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const app = express()

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json())

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'
const DAILY_LIMIT = 100

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ===================== FUNÇÕES DE CONTROLE DIÁRIO =====================
async function getDailyCount(licenseKey) {
  if (!licenseKey) return 0
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
  if (!licenseKey) return 0
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

// ===================== OUTRAS FUNÇÕES (mantidas) =====================
function generatePremiumKey() { /* ... mesmo código */ }
function addDays(date, days) { /* ... mesmo código */ }
function cleanKey(value = '') { return String(value).trim().toUpperCase() }
function normalizeLockedProfile(user = {}) { /* ... mesmo código */ }
function requireAdmin(req, res) { /* ... mesmo código */ }

async function downloadFileFromUrl(url) { /* ... mesmo código */ }
async function prepareAttachments(attachments = []) { /* ... mesmo código */ }

// ===================== ROTAS =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend v2 - Controle diário no Supabase' })
})

// Nova rota para buscar estatísticas diárias
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

// Rota de envio (atualizada)
app.post('/api/send-candidature', async (req, res) => {
  try {
    const { candidateName, candidateEmail, candidatePhone, employerName, employerEmail, jobTitle, messageBody, attachments, licenseKey } = req.body

    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: 'licenseKey é obrigatório. Faça login novamente.' })
    }

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: `Limite diário de ${DAILY_LIMIT} envios atingido.` })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    const employerHtml = `<div style="font-family:Arial,sans-serif;padding:20px;"><h2>Candidatura para ${jobTitle}</h2><p>Dear Hiring Manager,</p><p>${messageBody || 'I am interested in this position.'}</p><p><strong>Candidate:</strong> ${candidateName}</p><p><strong>Email:</strong> ${candidateEmail}</p></div>`

    const targetEmail = process.env.TEST_EMPLOYER_EMAIL || employerEmail

    if (targetEmail?.includes('@')) {
      await resend.emails.send({
        from: `${candidateName} <${FROM_EMAIL}>`,
        to: targetEmail,
        reply_to: candidateEmail,
        subject: `Application: ${candidateName} — ${jobTitle}`,
        html: employerHtml,
        attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      })
    }

    await resend.emails.send({
      from: `Future EUA H2B <${FROM_EMAIL}>`,
      to: candidateEmail,
      subject: `✅ Candidatura enviada - ${jobTitle}`,
      html: `<h2>Candidatura enviada!</h2><p>Enviada para: ${employerName}</p><p>Enviados hoje: ${currentCount + 1}/${DAILY_LIMIT}</p>`,
    })

    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    return res.json({ 
      ok: true, 
      message: 'Enviado com sucesso!',
      dailySent: newCount,
      remaining: DAILY_LIMIT - newCount
    })

  } catch (error) {
    console.error('Erro:', error)
    return res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`✅ Backend rodando na porta ${PORT} - Controle diário ATIVO`)
})