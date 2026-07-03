import { google } from 'googleapis'

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
)

export function getAuthUrl(userEmail) {
  const scopes = ['https://www.googleapis.com/auth/gmail.send']

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state: userEmail
  })
}

export async function getTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code)
  return tokens
}

function getAuthenticatedClient(refreshToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  client.setCredentials({ refresh_token: refreshToken })
  return client
}

function buildRawEmail({ from, to, subject, htmlBody, attachments = [] }) {
  const boundary = 'future_eua_boundary_' + Date.now()

  let message = ''
  message += `From: ${from}\r\n`
  message += `To: ${to}\r\n`
  message += `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=\r\n`
  message += `MIME-Version: 1.0\r\n`
  message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`

  message += `--${boundary}\r\n`
  message += `Content-Type: text/html; charset="UTF-8"\r\n`
  message += `Content-Transfer-Encoding: 7bit\r\n\r\n`
  message += `${htmlBody}\r\n\r\n`

  for (const att of attachments) {
    message += `--${boundary}\r\n`
    message += `Content-Type: ${att.mimeType || 'application/pdf'}; name="${att.filename}"\r\n`
    message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`
    message += `Content-Transfer-Encoding: base64\r\n\r\n`
    message += `${att.contentBase64}\r\n\r\n`
  }

  message += `--${boundary}--`

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function sendEmailViaGmail({ refreshToken, from, to, subject, htmlBody, attachments = [] }) {
  const authClient = getAuthenticatedClient(refreshToken)
  const gmail = google.gmail({ version: 'v1', auth: authClient })

  const raw = buildRawEmail({ from, to, subject, htmlBody, attachments })

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  })

  return result.data
}