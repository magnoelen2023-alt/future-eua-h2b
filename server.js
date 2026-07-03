import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { getAuthUrl, getTokensFromCode, sendEmailViaGmail } from './gmailAuth.js'

const app = express()

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json({ limit: '25mb' }))

const PORT = process.env.PORT || 3001
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MAGNO-ADMIN-2026'
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://future-eua-h2b.vercel.app'

// FASE DE LANÇAMENTO: Limite fixo em 100 candidaturas por usuário.
const DAILY_LIMIT_PER_USER = 100

const BREVO_API_KEY = process.env.BREVO_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'futureeuah2b@gmail.com'
const FROM_NAME = 'Future EUA H2B'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ===================== ENVIO VIA BREVO API (HTTPS) =====================
async function sendEmailBrevo({ to, toName, subject, html, replyTo, attachments = [] }) {
  const payload = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: to, name: toName || to }],
    subject,
    htmlContent: html,
  }

  if (replyTo) payload.replyTo = { email: replyTo }

  if (attachments.length > 0) {
    payload.attachment = attachments.map(a => ({
      name: a.filename,
      content: a.content.toString('base64'),
    }))
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.message || `Erro Brevo (${response.status})`)
  }

  return data
}

// ===================== CONTROLE DIÁRIO (SUPABASE) =====================
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
  const current = await getDailyCount(licenseKey)
  const newCount = current + 1

  await supabase.from('daily_sends').upsert({
    license_key: licenseKey,
    user_email: userEmail,
    send_date: today,
    count: newCount,
  }, { onConflict: 'license_key,send_date' })

  return newCount
}

// ===================== FUNÇÕES AUXILIARES =====================
function generatePremiumKey() {
  const gen = (n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('')
  return `${gen(4)}-${gen(4)}-${gen(4)}-${gen(4)}`
}

function requireAdmin(req, res) {
  const received = req.headers['x-admin-secret'] || req.query.secret || req.body?.secret
  if (received !== ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: 'Acesso negado.' })
    return false
  }
  return true
}

async function downloadFileFromUrl(url) {
  try {
    if (!url) return null
    const response = await fetch(url)
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null
  } catch (e) { return null }
}

async function prepareAttachments(attachments = []) {
  const prepared = []
  for (const att of (Array.isArray(attachments) ? attachments : [])) {
    if (!att?.url) continue
    const buffer = await downloadFileFromUrl(att.url)
    if (buffer) prepared.push({ filename: att.filename || 'documento.pdf', content: buffer, mimeType: 'application/pdf' })
  }
  return prepared
}

// ===================== ROTAS =====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: `Backend v8.0 - Gmail API + Brevo | Limite Fixo: ${DAILY_LIMIT_PER_USER}/dia` })
})

// Rota 1: gera o link de autorização do Google
app.get('/api/gmail/auth-url', (req, res) => {
  const userEmail = req.query.email;
  if (!userEmail) {
    return res.status(400).json({ error: 'Email do usuário é obrigatório' });
  }
  const url = getAuthUrl(userEmail);
  res.json({ url });
});

// Rota 2: callback que o Google chama depois que o usuário autoriza
app.get('/api/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  const userEmail = state;

  try {
    const tokens = await getTokensFromCode(code);

    if (!tokens.refresh_token) {
      return res.redirect(`${FRONTEND_URL}/gmail-conectado?status=erro&motivo=sem_refresh_token`);
    }

    const { error } = await supabase
      .from('users')
      .update({
        gmail_connected: true,
        gmail_email: userEmail,
        gmail_refresh_token: tokens.refresh_token,
        gmail_connected_at: new Date().toISOString()
      })
      .eq('email', userEmail);

    if (error) {
      console.error('Erro ao salvar tokens no Supabase:', error);
      return res.redirect(`${FRONTEND_URL}/gmail-conectado?status=erro`);
    }

    return res.redirect(`${FRONTEND_URL}/gmail-conectado?status=sucesso`);

  } catch (err) {
    console.error('Erro no callback do Gmail:', err);
    return res.redirect(`${FRONTEND_URL}/gmail-conectado?status=erro`);
  }
});

app.get('/api/admin/generate-key', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const key = generatePremiumKey()
  const email = (req.query.email || '').toLowerCase()
  const days = parseInt(req.query.days) || 180
  const { data, error } = await supabase
    .from('licenses')
    .insert([{ key, status: 'unused', assigned_email: email, days_valid: days }])
    .select()
    .single()
  if (error) return res.status(500).json({ ok: false, error: error.message })
  res.json({ ok: true, key, license: data })
})

app.get('/api/admin/licenses', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { data } = await supabase.from('licenses').select('*').order('created_at', { ascending: false })
  res.json({ ok: true, licenses: data })
})

app.post('/api/activate-key', async (req, res) => {
  try {
    const { key, user } = req.body
    const cleanedKey = String(key).trim().toUpperCase()
    const userEmail = user.email.trim().toLowerCase()

    const { data: license, error } = await supabase.from('licenses').select('*').eq('key', cleanedKey).single()
    if (error || !license) return res.status(404).json({ ok: false, error: 'Chave inválida.' })

    if (license.status === 'active') {
      if (license.assigned_email !== userEmail) return res.status(403).json({ ok: false, error: 'Chave de outro usuário.' })
      return res.json({ ok: true, license, userUpdate: { premium: true, premiumExpiresAt: license.expires_at, accessKey: license.key } })
    }

    const now = new Date()
    const expiresAt = new Date(now)
    expiresAt.setDate(expiresAt.getDate() + (license.days_valid || 180))

    const { data: updated } = await supabase.from('licenses').update({
      status: 'active',
      assigned_email: userEmail,
      activated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }).eq('key', cleanedKey).select().single()

    res.json({
      ok: true,
      license: updated,
      userUpdate: { premium: true, accessKey: cleanedKey, premiumExpiresAt: expiresAt.toISOString() }
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/api/daily-stats', async (req, res) => {
  const { licenseKey } = req.query
  const count = await getDailyCount(licenseKey)
  res.json({ ok: true, dailySent: count, dailyLimit: DAILY_LIMIT_PER_USER, remaining: Math.max(0, DAILY_LIMIT_PER_USER - count) })
})

// ===================== ROTA PRINCIPAL DE ENVIO (COM GMAIL API) =====================
app.post('/api/send-candidature', async (req, res) => {
  try {
    const {
      candidateName, candidateEmail, candidatePhone, employerName, employerEmail,
      jobTitle, jobLocation, caseNumber, messageBody, attachments, licenseKey
    } = req.body

    console.log('📨 Processando candidatura de:', candidateName, 'para:', employerName)

    if (!licenseKey) return res.status(400).json({ ok: false, error: 'LicenseKey necessária.' })
    if (!candidateEmail || !jobTitle) return res.status(400).json({ ok: false, error: 'Dados faltantes.' })

    const currentCount = await getDailyCount(licenseKey)
    if (currentCount >= DAILY_LIMIT_PER_USER) {
      return res.status(429).json({ ok: false, error: `Limite diário de ${DAILY_LIMIT_PER_USER} candidaturas atingido.` })
    }

    const emailAttachments = await prepareAttachments(attachments)

    // Busca o usuário para verificar se tem Gmail conectado
    const { data: user } = await supabase
      .from('users')
      .select('gmail_connected, gmail_refresh_token, email')
      .eq('email', candidateEmail)
      .single();

    const useGmail = user?.gmail_connected && user?.gmail_refresh_token;

    // ===================== 1. HTML PARA O EMPREGADOR =====================
    const employerHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222; border: 1px solid #e0e0e0;">
        <div style="background:#1a3a8f;color:#fff;padding:20px;text-align:center;">
          <h2 style="margin:0;">Job Application — ${jobTitle}</h2>
          <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">H-2B Visa Seasonal Program</p>
        </div>
        <div style="padding:24px;">
          <p>Dear Hiring Manager at <strong>${employerName}</strong>,</p>
          <div style="background:#f8f9fa;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #1a3a8f;">
            <p style="margin:0;white-space:pre-line;">${messageBody || 'I am writing to express my interest in this seasonal position.'}</p>
          </div>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
          <h3 style="color:#1a3a8f;margin-bottom:10px;">📋 Position Details</h3>
          <p><strong>Position:</strong> ${jobTitle}</p>
          <p><strong>Location:</strong> ${jobLocation || 'N/A'}</p>
          <p><strong>Case #:</strong> ${caseNumber || 'N/A'}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
          <h3 style="color:#1a3a8f;margin-bottom:10px;">👤 Candidate Information</h3>
          <p><strong>Name:</strong> ${candidateName}</p>
          <p><strong>Email:</strong> ${candidateEmail}</p>
          <p><strong>Phone:</strong> ${candidatePhone || 'N/A'}</p>
          ${emailAttachments.length > 0 ? `
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
          <h3 style="color:#1a3a8f;margin-bottom:10px;">📎 Attached Documents</h3>
          <ul>${emailAttachments.map(a => `<li>${a.filename}</li>`).join('')}</ul>` : ''}
          <p style="margin-top:24px;">Sincerely,<br><strong>${candidateName}</strong></p>
        </div>
      </div>
    `

    const target = process.env.TEST_EMPLOYER_EMAIL || employerEmail
    let employerSent = false

    if (target?.includes('@')) {
      try {
        if (useGmail) {
          // 🟢 ENVIA PELO GMAIL DO USUÁRIO
          const gmailAttachments = emailAttachments.map(a => ({
            filename: a.filename,
            contentBase64: a.content.toString('base64'),
            mimeType: a.mimeType || 'application/pdf'
          }));

          await sendEmailViaGmail({
            refreshToken: user.gmail_refresh_token,
            from: candidateEmail,
            to: target,
            subject: `Application: ${candidateName} — ${jobTitle}`,
            htmlBody: employerHtml,
            attachments: gmailAttachments
          });
          console.log(`✅ Enviado via Gmail API para: ${target}`);
        } else {
          // 🟡 FALLBACK: Brevo
          await sendEmailBrevo({
            to: target,
            toName: employerName,
            subject: `Application: ${candidateName} — ${jobTitle}`,
            html: employerHtml,
            replyTo: candidateEmail,
            attachments: emailAttachments,
          });
          console.log(`✅ Enviado via Brevo para: ${target} (replyTo: ${candidateEmail})`);
        }
        employerSent = true;
      } catch (err) { 
        console.error('Erro ao enviar ao empregador:', err.message);
        // Se der erro no Gmail, tenta fallback no Brevo (opcional, mas recomendado)
        if (useGmail) {
          try {
            await sendEmailBrevo({
              to: target,
              toName: employerName,
              subject: `Application: ${candidateName} — ${jobTitle}`,
              html: employerHtml,
              replyTo: candidateEmail,
              attachments: emailAttachments,
            });
            employerSent = true;
            console.log(`✅ Fallback Brevo funcionou após erro no Gmail.`);
          } catch (err2) {
            console.error('Erro no fallback Brevo:', err2.message);
          }
        }
      }
    }

    // ===================== 2. HTML PARA O CANDIDATO (ESPELHO FIEL) =====================
    const candidateHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #222; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background:#16a34a;color:#fff;padding:20px;text-align:center;">
          <h2 style="margin:0;">✅ Cópia da Candidatura Enviada</h2>
        </div>
        <div style="padding:24px;">
          <p>Olá, <strong>${candidateName}</strong>!</p>
          <p>Este é o <strong>espelho exato</strong> do e-mail que enviamos para <strong>${employerName}</strong> (${target}).</p>
          <div style="background:#f0fdf4;padding:14px;border-radius:8px;margin:16px 0;border-left:4px solid #16a34a;">
            <p style="margin:0;"><strong>Vaga:</strong> ${jobTitle}</p>
            <p style="margin:6px 0 0;"><strong>Envios hoje:</strong> ${currentCount + 1} de ${DAILY_LIMIT_PER_USER}</p>
          </div>
          <p style="font-size:13px;color:#666;margin-bottom:20px;">
            Qualquer resposta do empregador (automática ou manual) chegará diretamente na sua caixa de entrada.
          </p>
          <hr style="border:none;border-top:2px dashed #ccc;margin:20px 0;">
        </div>
        ${employerHtml}
      </div>
    `

    let candidateSent = false
    try {
      await sendEmailBrevo({
        to: candidateEmail,
        toName: candidateName,
        subject: `[CÓPIA] Application: ${candidateName} — ${jobTitle}`,
        html: candidateHtml,
        attachments: emailAttachments,
      })
      candidateSent = true
      console.log(`✅ Cópia enviada ao candidato: ${candidateEmail}`)
    } catch (err) { console.error('Erro candidato:', err.message) }

    const newCount = await incrementDailyCount(licenseKey, candidateEmail)

    res.json({
      ok: true,
      dailySent: newCount,
      dailyLimit: DAILY_LIMIT_PER_USER,
      employerSent,
      candidateSent,
      sentVia: useGmail ? 'gmail' : 'brevo',
    })
  } catch (error) {
    console.error('❌ ERRO CRÍTICO:', error)
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 v8.0 Online na porta ${PORT} | Gmail API + Brevo | Limite Fixo: ${DAILY_LIMIT_PER_USER}`)
})