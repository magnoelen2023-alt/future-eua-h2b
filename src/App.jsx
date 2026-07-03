import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Papa from 'papaparse'
import { supabase } from './supabase'

const DAILY_LIMIT = 100
const DEMO_LIMIT = 10
const FREE_ACCESS_KEY = 'FREE-H2B-2026'
const CONTACT_LINK = 'https://wa.me/5575999866105?text=Olá,%20quero%20comprar%20a%20chave%20Premium.%20Meu%20e-mail%20é:%20'
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const USER_SESSION_KEY = 'h2b-user-session'

const seasons = [
  { id: 'winter-2025', label: '❄ Inverno 2025', short: 'Inverno', csvFile: '/vagas_inverno_2025_h2b.csv' },
  { id: 'summer-2026', label: '☀ Verão 2026', short: 'Verão', csvFile: null },
]

// ===================== FUNÇÕES AUXILIARES =====================
function normalizeKey(value = '') {
  return String(value).replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function getRowValue(row, possibleKeys = []) {
  const normalizedMap = {}
  Object.entries(row || {}).forEach(([key, value]) => { normalizedMap[normalizeKey(key)] = value })
  for (const key of possibleKeys) {
    const found = normalizedMap[normalizeKey(key)]
    if (found !== undefined && found !== null && String(found).trim() !== '') return String(found).trim()
  }
  return ''
}

function detectCategory(title = '') {
  const t = title.toLowerCase()
  if (t.includes('housekeep') || t.includes('hotel') || t.includes('room attendant') || t.includes('resort')) return 'Hotelaria'
  if (t.includes('cook') || t.includes('chef') || t.includes('kitchen') || t.includes('food prep')) return 'Cozinha'
  if (t.includes('dishwash')) return 'Dishwasher'
  if (t.includes('server') || t.includes('waiter') || t.includes('waitress') || t.includes('restaurant') || t.includes('food') || t.includes('counter')) return 'Restaurantes'
  if (t.includes('landscape') || t.includes('groundskeep') || t.includes('lawn') || t.includes('garden')) return 'Landscaping'
  if (t.includes('clean') || t.includes('janitor') || t.includes('laundry')) return 'Limpeza'
  if (t.includes('construct') || t.includes('roof') || t.includes('mason') || t.includes('carpent') || t.includes('paint') || t.includes('laborer')) return 'Construção'
  if (t.includes('farm') || t.includes('agricult') || t.includes('harvest') || t.includes('field')) return 'Fazendas H2A'
  if (t.includes('amusement') || t.includes('recreation') || t.includes('park')) return 'Parques & Recreação'
  return 'Outros'
}

function formatState(state = '') {
  return state.trim().toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase())
}

function formatDate(value = '') {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString().split('T')[0]
}

function formatWageValue(value = '') {
  const clean = String(value).trim()
  return clean ? (clean.includes('$') ? clean : `$${clean}/h`) : 'A combinar'
}

function parseJobFromCsv(row, index, seasonId) {
  const caseNumber = getRowValue(row, ['Case number'])
  const employer = getRowValue(row, ['Nome da empresa'])
  const state = formatState(getRowValue(row, ['Estado']))
  const title = getRowValue(row, ['Título do cargo', 'Titulo do cargo'])
  const contact = getRowValue(row, ['E-mail do empregador', 'Email do empregador'])
  const phone = getRowValue(row, ['Telefone do empregador'])
  const description = getRowValue(row, ['Responsabilidades do cargo', 'Responsabilidade do cargo'])
  const city = getRowValue(row, ['Cidade'])
  const visaType = getRowValue(row, ['Tipo do visto']) || 'H-2B'
  const wageRaw = getRowValue(row, ['wage_per_hour'])
  const startDate = formatDate(getRowValue(row, ['Data de início', 'Data de inicio']))
  const endDate = formatDate(getRowValue(row, ['Data de fim']))
  const agent = getRowValue(row, ['Nome do advogado do agente'])
  return {
    seasonId, id: `${seasonId}-${caseNumber || index}`, number: index + 1,
    title: title || 'Vaga sem título', category: detectCategory(title),
    employer: employer || 'Empregador', city, state,
    location: city && state ? `${city}, ${state}` : (city || state || 'EUA'),
    fullLocation: city && state ? `${city}, ${state}, USA` : 'Estados Unidos',
    available: 1, startDate, endDate, wage: formatWageValue(wageRaw),
    wageDetail: wageRaw ? `US$ ${wageRaw} por hora.` : 'Salário a combinar.',
    caseNumber, contact, phone, visaType, agent,
    description: description || 'Descrição não informada.',
  }
}

function getLocalDateKey(value = new Date()) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function loadUserSession() {
  try {
    const raw = localStorage.getItem(USER_SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function createQueueId() { return `QUEUE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function createSentId() { return `SENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

function randomDelay(fastMode) {
  return fastMode
    ? Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000
    : Math.floor(Math.random() * (240000 - 90000 + 1)) + 90000
}

function formatSeconds(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m <= 0 ? `${sec}s` : `${m}min ${String(sec).padStart(2, '0')}s`
}

function getInitials(name = '') {
  const p = name.trim().split(' ').filter(Boolean)
  return p.length === 0 ? 'FE' : p.length === 1 ? p[0].slice(0, 2).toUpperCase() : `${p[0][0]}${p[p.length - 1][0]}`.toUpperCase()
}

function progressColor(p) { return p < 35 ? 'green' : p < 75 ? 'yellow' : 'red' }

function translateJobTitleToPt(title = '') {
  const t = title.toLowerCase().trim()
  if (t.includes('dishwash')) return 'Lavador de pratos'
  if (t.includes('server')) return 'Garçom / Atendente'
  if (t.includes('waiter')) return 'Garçom'
  if (t.includes('waitress')) return 'Garçonete'
  if (t.includes('cook')) return 'Cozinheiro'
  if (t.includes('chef')) return 'Chef de cozinha'
  if (t.includes('housekeep')) return 'Camareira / Arrumação'
  if (t.includes('room attendant')) return 'Atendente de quartos'
  if (t.includes('clean')) return 'Auxiliar de limpeza'
  if (t.includes('janitor')) return 'Zelador'
  if (t.includes('landscape')) return 'Trabalhador de paisagismo'
  if (t.includes('groundskeep')) return 'Manutenção de áreas externas'
  if (t.includes('roof')) return 'Telhadista'
  if (t.includes('construction')) return 'Trabalhador da construção'
  if (t.includes('laborer')) return 'Trabalhador geral'
  if (t.includes('maintenance')) return 'Auxiliar de manutenção'
  if (t.includes('laundry')) return 'Auxiliar de lavanderia'
  if (t.includes('cashier')) return 'Caixa'
  if (t.includes('bartender')) return 'Bartender'
  if (t.includes('painter')) return 'Pintor'
  if (t.includes('carpenter')) return 'Carpinteiro'
  if (t.includes('farm')) return 'Trabalhador rural'
  return title
}

function getPortugueseResponsibilities(job) {
  const title = (job?.title || '').toLowerCase()
  const category = (job?.category || '').toLowerCase()
  if (title.includes('dishwash')) return 'realizar a lavagem de pratos, copos, panelas, utensílios e equipamentos de cozinha, mantendo a área limpa, organizada e pronta para operação.'
  if (title.includes('server') || title.includes('waiter')) return 'atender clientes, anotar pedidos, servir alimentos e bebidas, organizar mesas e apoiar o funcionamento do salão.'
  if (title.includes('cook') || title.includes('chef')) return 'preparar alimentos, organizar ingredientes, manter os padrões de higiene da cozinha e apoiar a produção.'
  if (title.includes('housekeep') || category.includes('hotelaria')) return 'executar limpeza, arrumação e organização de quartos e áreas internas, seguindo os padrões de higiene.'
  if (title.includes('landscape')) return 'executar atividades de paisagismo e manutenção de áreas externas.'
  return 'executar as atividades principais da função conforme orientação do empregador, respeitando padrões de qualidade e segurança.'
}

function buildPortugueseJobDescription(job) {
  if (!job) return 'Selecione uma vaga para ver os detalhes.'
  return `A vaga de ${translateJobTitleToPt(job.title)} está localizada em ${job.fullLocation}. Profissional responsável por ${getPortugueseResponsibilities(job)} O salário informado é: ${job.wageDetail}. Período: ${job.startDate} a ${job.endDate}. Visto: ${job.visaType}.`
}

function getLicenseKey(user = {}) {
  return (
    user?.access_key ||
    user?.accessKey ||
    user?.premium_access_key ||
    user?.premiumAccessKey ||
    ''
  )
}

// ===================== COMPONENTE PRINCIPAL =====================
export default function App() {
  const [user, setUser] = useState(null)
  const [isPremium, setIsPremium] = useState(false)
  const [accessKey, setAccessKey] = useState('')
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const [selectedSeason, setSelectedSeason] = useState(seasons[0])
  const [jobs, setJobs] = useState([])
  const [queue, setQueue] = useState([])
  const [sentLogs, setSentLogs] = useState([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [fastMode, setFastMode] = useState(true)
  const [message, setMessage] = useState('')
  const intervalRef = useRef(null)

  // ===================== CARREGAR DADOS DO USUÁRIO =====================
  const loadUserData = useCallback(async (userData) => {
    if (!userData?.email) return

    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('email', userData.email)
      .single()

    if (data) {
      setUser(data)
      setIsPremium(!!data.premium)
      setAccessKey(data.access_key || data.accessKey || '')
      setGmailConnected(!!data.gmail_connected)
      setGmailEmail(data.gmail_email || '')
    }
  }, [])

  // ===================== VERIFICAR CALLBACK DO GMAIL =====================
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const gmailStatus = params.get('gmail')

    if (gmailStatus === 'sucesso') {
      setMessage('✅ Gmail conectado com sucesso! Agora suas respostas automáticas vão chegar direto na sua conta.')
      setGmailConnected(true)
      // Limpa a URL
      window.history.replaceState({}, document.title, window.location.pathname)
    } else if (gmailStatus === 'erro') {
      setMessage('❌ Erro ao conectar o Gmail. Tente novamente.')
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [])

  // ===================== CARREGAR USUÁRIO =====================
  useEffect(() => {
    const session = loadUserSession()
    if (session) {
      setUser(session)
      loadUserData(session)
    }
  }, [loadUserData])

  // ===================== CARREGAR VAGAS =====================
  useEffect(() => {
    if (!selectedSeason.csvFile) return

    fetch(selectedSeason.csvFile)
      .then(res => res.text())
      .then(csv => {
        Papa.parse(csv, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => {
            const parsed = result.data
              .map((row, index) => parseJobFromCsv(row, index, selectedSeason.id))
              .filter(job => job.title && job.employer)
            setJobs(parsed)
          }
        })
      })
  }, [selectedSeason])

  // ===================== CONECTAR GMAIL =====================
  const connectGmail = async () => {
    if (!user?.email) {
      alert('Faça login primeiro')
      return
    }

    try {
      const res = await fetch(`${API_URL}/api/gmail/auth-url?email=${encodeURIComponent(user.email)}`)
      const data = await res.json()

      if (data.url) {
        window.location.href = data.url
      } else {
        alert('Erro ao gerar link do Google')
      }
    } catch (err) {
      console.error(err)
      alert('Erro de conexão com o servidor')
    }
  }

  const disconnectGmail = async () => {
    if (!user?.email) return
    if (!window.confirm('Desconectar sua conta do Gmail?')) return

    try {
      await fetch(`${API_URL}/api/gmail/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email })
      })

      setGmailConnected(false)
      setGmailEmail('')
      setMessage('Gmail desconectado com sucesso.')
    } catch (err) {
      alert('Erro ao desconectar')
    }
  }

  // ===================== FUNÇÃO DE ENVIO (já adaptada para Gmail) =====================
  const sendCandidature = async (job) => {
    if (!isPremium && queue.length >= DEMO_LIMIT) {
      alert('Limite de demonstração atingido. Ative a chave Premium.')
      return
    }

    if (!accessKey && isPremium) {
      alert('Chave Premium não encontrada.')
      return
    }

    const newItem = {
      id: createQueueId(),
      job,
      status: 'pending',
      attempts: 0
    }

    setQueue(prev => [...prev, newItem])
    setMessage(`Vaga "${job.title}" adicionada à fila.`)
  }

  // ... (o resto do seu código de fila, processamento, etc. continua igual)

  return (
    <div className="min-h-screen bg-[#0a0f1c] text-white">
      {/* Seu header, navbar, etc. permanecem iguais */}

      <div className="max-w-6xl mx-auto p-6">
        {/* ==================== SEÇÃO PREMIUM ==================== */}
        <div className="bg-[#121a2b] rounded-2xl p-6 mb-8 border border-[#1e2a4a]">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-3">
            🔑 Chave Premium & Integrações
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Card da Chave Premium */}
            <div className="bg-[#0f1625] p-6 rounded-xl border border-[#1e2a4a]">
              <h3 className="text-lg font-semibold mb-4">Chave Premium</h3>
              {/* Seu código atual de ativação de chave */}
              {/* ... */}
            </div>

            {/* NOVO CARD - CONECTAR GMAIL */}
            <div className="bg-[#0f1625] p-6 rounded-xl border border-[#1e2a4a]">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                📧 Conectar Gmail
                {gmailConnected && <span className="text-green-400 text-sm">(Conectado)</span>}
              </h3>
              
              <p className="text-gray-400 text-sm mb-6">
                Conecte sua conta do Gmail para que as respostas automáticas dos empregadores (férias, vaga encerrada, etc.) cheguem diretamente na sua caixa de entrada.
              </p>

              {gmailConnected ? (
                <div className="space-y-4">
                  <div className="bg-green-900/30 border border-green-500 rounded-lg p-4">
                    <p className="text-green-400">✅ Conectado como:</p>
                    <p className="font-mono text-sm mt-1">{gmailEmail || user?.email}</p>
                  </div>
                  <button
                    onClick={disconnectGmail}
                    className="w-full py-3 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition"
                  >
                    Desconectar Gmail
                  </button>
                </div>
              ) : (
                <button
                  onClick={connectGmail}
                  className="w-full py-4 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 rounded-xl font-bold text-lg transition-all active:scale-95"
                >
                  🔗 Conectar meu Gmail
                </button>
              )}

              <p className="text-[10px] text-gray-500 mt-4 text-center">
                Suas respostas automáticas dos empregadores vão chegar direto na sua conta do Gmail.
              </p>
            </div>
          </div>
        </div>

        {/* Resto do seu código (fila, vagas, etc.) permanece igual */}
        {/* ... seu código original continua aqui ... */}

      </div>
    </div>
  )
}