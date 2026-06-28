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

// ===================== FUNÇÕES DE CONTROLE DIÁRIO (CORRIGIDAS) =====================
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
    console.error('Erro ao buscar daily count:', error)
    return 0
  }

  return data?.count || 0
}

async function incrementDailyCount(licenseKey, userEmail) {
  if (!licenseKey) return 0
  const today = new Date().toISOString().split('T')[0]

  // Tenta atualizar primeiro
  const { data: updated, error: updateError } = await supabase
    .from('daily_sends')
    .update({ count: supabase.raw('count + 1') })
    .eq('license_key', licenseKey)
    .eq('send_date', today)
    .select()
    .maybeSingle()

  if (updateError) {
    console.error('Erro ao incrementar daily count:', updateError)
    return 0
  }

  // Se atualizou, retorna o novo valor
  if (updated) {
    return updated.count
  }

  // Se não existia, cria um novo registro
  const { data: inserted, error: insertError } = await supabase
    .from('daily_sends')
    .insert([{
      license_key: licenseKey,
      user_email: userEmail,
      send_date: today,
      count: 1
    }])
    .select()
    .single()

  if (insertError) {
    console.error('Erro ao criar daily count:', insertError)
    return 0
  }

  return inserted.count
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
  res.json({ ok: true, message: 'Backend v2 - Controle diário no Supabase' })
})

// GERAR KEY
app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const email = (req.query.email || '').toLowerCase()
    const days = parseInt(req.query.days) || 180
    const key = generatePremiumKey()
    const { data, error } = await supabase.from('licenses').insert([{ key, status: 'unused', assigned_email: email, days_valid: days }]).select().single()
    if (error) return res.status(500).json({ ok: false, error: error.message })
    return res.json({ ok: true, key, license: data })
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message })
  }
})

// LISTAR KEYS
app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { data } = await supabase.from('licenses').select('*').order('created_at', { ascending: false })
  return res.json({ ok: true, licenses: data })
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

// BUSCAR ESTATÍSTICAS DIÁRIAS
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

// ENVIAR CANDIDATURA
app.post('/api/send-candidature', async (req, res) => {
  try {
    const { candidateName, candidateEmail, candidatePhone, employerName, employerEmail, jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey } = req.body

    console.log('═══════════════════════════════════════════')
    console.log('📨 INICIANDO ENVIO DE CANDIDATURA')
    console.log('═══════════════════════════════════════════')
    console.log('👤 Candidato:', candidateName)
    console.log('📧 Candidato email:', candidateEmail)
    console.log(' Empregador:', employerName)
    console.log('📧 Empregador email:', employerEmail)
    console.log('💼 Vaga:', jobTitle)
    console.log('🔑 LicenseKey:', licenseKey || 'NÃO INFORMADA')

    if (!candidateEmail || !jobTitle || !licenseKey) {
      return res.status(400).json({
        ok: false,
        error: 'Dados obrigatórios faltando.',
      })
    }

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({
        ok: false,
        error: `Limite diário de ${DAILY_LIMIT} envios atingido.`,
      })
    }

    const emailAttachments = await prepareAttachments(attachments || [])

    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #1a3a8f; color: white; padding: 20px; text-align: center;">
          <h2>Job Application — ${jobTitle}</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <p>${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <h3>Candidate:</h3>
          <p><strong>${candidateName}</strong></p>
          <p><strong>Email:</strong> ${candidateEmail}</p>
          <p><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
          <p><strong>Position:</strong> ${jobTitle}</p>
          <p><strong>Location:</strong> ${jobLocation || 'N/A'}</p>
          <p><strong>Case #:</strong> ${caseNumber || 'N/A'}</p>
          <p style="font-size: 12px; color: #777; margin-top: 24px;">
            Sent via FUTURE EUA H2B platform
          </p>
        </div>
      </div>
    `

    const rawEmployerEmail = String(employerEmail || '').trim()
    const testEmployerEmail = String(process.env.TEST_EMPLOYER_EMAIL || '').trim()
    const employerTargetEmail = testEmployerEmail || rawEmployerEmail

    console.log('📧 E-mail destino do empregador:', employerTargetEmail || 'NENHUM')
    console.log('📧 Respostas devem ir para:', candidateEmail)
    console.log('📧 FROM_EMAIL:', FROM_EMAIL)

    // ENVIAR PARA EMPREGADOR
    let employerEmailSent = false
    let employerEmailError = null

    if (employerTargetEmail && employerTargetEmail.includes('@')) {
      try {
        console.log(' Enviando e-mail para o empregador...')
        const result = await resend.emails.send({
          from: `Future EUA H2B <${FROM_EMAIL}>`,
          to: [employerTargetEmail],
          replyTo: candidateEmail,
          subject: `Application: ${candidateName} — ${jobTitle}`,
          html: employerHtml,
          attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
        })

        employerEmailSent = true
        console.log('✅ E-mail do empregador enviado com sucesso')
        console.log('📨 Resend ID:', result?.data?.id || 'sem id')
      } catch (err) {
        employerEmailError = err?.message || 'Erro ao enviar e-mail para empregador'
        console.error('❌ Erro ao enviar e-mail ao empregador:', err)
      }
    } else {
      console.warn('⚠️ E-mail do empregador inválido ou ausente.')
    }

    // ENVIAR CONFIRMAÇÃO AO CANDIDATO
    let candidateEmailSent = false
    let candidateEmailError = null

    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222;">
        <div style="background: #16a34a; color: white; padding: 20px; text-align: center;">
          <h2>✅ Candidatura enviada com sucesso!</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e0e0e0;">
          <p>Olá, <strong>${candidateName}</strong>!</p>
          <p>Sua candidatura para <strong>${jobTitle}</strong> foi enviada.</p>

          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #16a34a;">
            <p style="margin: 0;"><strong>Empregador:</strong> ${employerName}</p>
            <p style="margin: 6px 0 0;"><strong>E-mail do empregador:</strong> ${employerTargetEmail || rawEmployerEmail || 'Não informado'}</p>
            <p style="margin: 6px 0 0;"><strong>Enviado em:</strong> ${new Date().toLocaleString('pt-BR')}</p>
            <p style="margin: 6px 0 0;"><strong>Envios hoje:</strong> ${currentCount + 1}/${DAILY_LIMIT}</p>
          </div>

          <p>
            Se o empregador tiver resposta automática, ela deve chegar no seu e-mail:
            <strong>${candidateEmail}</strong>
          </p>

          <p style="font-size: 12px; color: #777; margin-top: 24px;">
            Future EUA H2B — confirmação automática do sistema
          </p>
        </div>
      </div>
    `

    try {
      console.log('📤 Enviando e-mail de confirmação para o candidato...')
      const result = await resend.emails.send({
        from: `Future EUA H2B <${FROM_EMAIL}>`,
        to: [candidateEmail],
        subject: `✅ Candidatura enviada — ${jobTitle}`,
        html: candidateHtml,
      })

      candidateEmailSent = true
      console.log('✅ E-mail de confirmação enviado com sucesso')
      console.log('📨 Resend ID:', result?.data?.id || 'sem id')
    } catch (err) {
      candidateEmailError = err?.message || 'Erro ao enviar confirmação ao candidato'
      console.error('❌ Erro ao enviar e-mail de confirmação:', err)
    }

    // SALVAR CONTADOR
    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    console.log('═══════════════════════════════════════════')
    console.log('✅ PROCESSO FINALIZADO')
    console.log(' Empregador enviado:', employerEmailSent)
    console.log('📧 Candidato enviado:', candidateEmailSent)
    console.log('═══════════════════════════════════════════')

    return res.json({
      ok: true,
      message: 'Processo concluído.',
      dailySent: newCount,
      dailyLimit: DAILY_LIMIT,
      employerEmailSent,
      candidateEmailSent,
      warnings: {
        employerEmailError,
        candidateEmailError,
      },
    })
  } catch (error) {
    console.error('❌ ERRO CRÍTICO NA ROTA:', error)
    return res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════')
  console.log(`✅ Backend rodando na porta ${PORT}`)
  console.log(` Resend From: ${FROM_EMAIL}`)
  console.log(`🗄️ Supabase: ${process.env.SUPABASE_URL ? 'Conectado' : 'NÃO CONFIGURADO'}`)
  console.log(`📊 Controle diário ativo (limite: ${DAILY_LIMIT})`)
  console.log('═══════════════════════════════════════════')
})