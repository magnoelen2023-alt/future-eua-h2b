import { google } from 'googleapis'

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getAuthUrl(userEmail) {
  const client = createOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.send'],
    prompt: 'consent',
    state: userEmail,
  })
}

export async function getTokensFromCode(code) {
  const client = createOAuthClient()
  const { tokens } = await client.getToken(code)
  return tokens
}

function buildRawEmail({ from, fromName, to, subject, htmlBody, attachments = [] }) {
  const boundary = 'future_eua_' + Date.now()
  let msg = ''
  msg += `From: ${fromName ? `"${fromName}" <${from}>` : from}\r\n`
  msg += `To: ${to}\r\n`
  msg += `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=\r\n`
  msg += 'MIME-Version: 1.0\r\n'
  msg += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`

  msg += `--${boundary}\r\n`
  msg += 'Content-Type: text/html; charset="UTF-8"\r\n'
  msg += 'Content-Transfer-Encoding: base64\r\n\r\n'
  msg += Buffer.from(htmlBody).toString('base64') + '\r\n\r\n'

  for (const att of attachments) {
    msg += `--${boundary}\r\n`
    msg += `Content-Type: application/pdf; name="${att.filename}"\r\n`
    msg += `Content-Disposition: attachment; filename="${att.filename}"\r\n`
    msg += 'Content-Transfer-Encoding: base64\r\n\r\n'
    msg += att.content.toString('base64') + '\r\n\r\n'
  }

  msg += `--${boundary}--`

  return Buffer.from(msg)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function sendEmailViaGmail({ refreshToken, from, fromName, to, subject, htmlBody, attachments = [] }) {
  const client = createOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const gmail = google.gmail({ version: 'v1', auth: client })
  const raw = buildRawEmail({ from, fromName, to, subject, htmlBody, attachments })
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  return result.data
}