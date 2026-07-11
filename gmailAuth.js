import { google } from 'googleapis'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://future-eua-h2b-api.onrender.com/api/gmail/callback'

function createOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
}

export function getAuthUrl(userEmail) {
  const oauth2Client = createOAuthClient()

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // 🔥 força refresh_token sempre
    scope: ['https://www.googleapis.com/auth/gmail.send'],
    state: String(userEmail || '').trim().toLowerCase(),
    include_granted_scopes: true,
  })
}

export async function getTokensFromCode(code) {
  const oauth2Client = createOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)

  // tenta descobrir o e-mail real da conta Google (se possível)
  let email = null
  try {
    oauth2Client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
    const me = await oauth2.userinfo.get()
    email = me?.data?.email || null
  } catch (e) {
    // se o escopo não permitir userinfo, ignora
    email = null
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    email,
  }
}

export async function sendEmailViaGmail({
  refreshToken,
  from,
  to,
  subject,
  htmlBody,
  attachments = [],
}) {
  if (!refreshToken) throw new Error('refreshToken ausente')
  if (!from) throw new Error('from ausente')
  if (!to) throw new Error('to ausente')

  const oauth2Client = createOAuthClient()
  oauth2Client.setCredentials({ refresh_token: refreshToken })

  // garante access_token fresco
  const access = await oauth2Client.getAccessToken()
  if (!access?.token) {
    throw new Error('Não foi possível obter access_token do Gmail')
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  // Monta MIME (com anexos se houver)
  const boundary = 'boundary_future_h2b_' + Date.now()
  const nl = '\r\n'

  let raw = ''
  raw += `From: ${from}${nl}`
  raw += `To: ${to}${nl}`
  raw += `Subject: =?UTF-8?B?${Buffer.from(subject || '').toString('base64')}?=${nl}`
  raw += `MIME-Version: 1.0${nl}`

  if (attachments.length > 0) {
    raw += `Content-Type: multipart/mixed; boundary="${boundary}"${nl}${nl}`
    raw += `--${boundary}${nl}`
    raw += `Content-Type: text/html; charset="UTF-8"${nl}`
    raw += `Content-Transfer-Encoding: base64${nl}${nl}`
    raw += `${Buffer.from(htmlBody || '', 'utf8').toString('base64')}${nl}`

    for (const att of attachments) {
      const filename = att.filename || 'anexo.pdf'
      const mimeType = att.mimeType || 'application/pdf'
      const contentBase64 = att.contentBase64 || ''

      raw += `--${boundary}${nl}`
      raw += `Content-Type: ${mimeType}; name="${filename}"${nl}`
      raw += `Content-Disposition: attachment; filename="${filename}"${nl}`
      raw += `Content-Transfer-Encoding: base64${nl}${nl}`
      raw += `${contentBase64}${nl}`
    }

    raw += `--${boundary}--`
  } else {
    raw += `Content-Type: text/html; charset="UTF-8"${nl}`
    raw += `Content-Transfer-Encoding: base64${nl}${nl}`
    raw += Buffer.from(htmlBody || '', 'utf8').toString('base64')
  }

  const encodedMessage = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  })

  return result.data
}