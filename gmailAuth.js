// gmailAuth.js
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Gera a URL que o usuário vai clicar para autorizar
function getAuthUrl(userEmail) {
  const scopes = ['https://www.googleapis.com/auth/gmail.send'];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // necessário para receber refresh_token
    scope: scopes,
    prompt: 'consent',      // força aparecer a tela de permissão sempre
    state: userEmail        // usamos isso pra saber QUEM está conectando
  });
}

// Troca o "code" que o Google manda pelo refresh_token
async function getTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

// Monta um cliente OAuth já autenticado com o refresh_token salvo
function getAuthenticatedClient(refreshToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Monta o e-mail no formato que o Gmail API exige (base64)
function buildRawEmail({ from, to, subject, htmlBody, attachments = [] }) {
  const boundary = 'future_eua_boundary_' + Date.now();

  let message = '';
  message += `From: ${from}\r\n`;
  message += `To: ${to}\r\n`;
  message += `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=\r\n`;
  message += `MIME-Version: 1.0\r\n`;
  message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

  // Corpo do e-mail (HTML)
  message += `--${boundary}\r\n`;
  message += `Content-Type: text/html; charset="UTF-8"\r\n`;
  message += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
  message += `${htmlBody}\r\n\r\n`;

  // Anexos
  for (const att of attachments) {
    // att = { filename, contentBase64, mimeType }
    message += `--${boundary}\r\n`;
    message += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
    message += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    message += `Content-Transfer-Encoding: base64\r\n\r\n`;
    message += `${att.contentBase64}\r\n\r\n`;
  }

  message += `--${boundary}--`;

  // Gmail API exige base64 URL-safe
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Envia o e-mail de fato usando a Gmail API
async function sendEmailViaGmail({ refreshToken, from, to, subject, htmlBody, attachments }) {
  const authClient = getAuthenticatedClient(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const raw = buildRawEmail({ from, to, subject, htmlBody, attachments });

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  return result.data; // contém o id da mensagem enviada
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  sendEmailViaGmail
};