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

function loadUserSession() {
  try {
    const raw = localStorage.getItem(USER_SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function createQueueId() { return `QUEUE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

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
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  // Carregar dados do Supabase
  const loadUserData = useCallback(async (userData) => {
    if (!userData?.email) return
    const { data } = await supabase.from('users').select('*').eq('email', userData.email).single()
    if (data) {
      setUser(data)
      setIsPremium(!!data.premium)
      setAccessKey(data.access_key || '')
      setGmailConnected(!!data.gmail_connected)
      setGmailEmail(data.gmail_email || '')
    }
  }, [])

  // Verificar se voltou do Google Auth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get('status')
    if (status === 'sucesso') {
      setMessage('✅ Gmail conectado com sucesso!')
      window.history.replaceState({}, document.title, window.location.pathname)
    } else if (status === 'erro') {
      setMessage('❌ Erro ao conectar o Gmail.')
    }
  }, [])

  useEffect(() => {
    const session = loadUserSession()
    if (session) loadUserData(session)
  }, [loadUserData])

  // Função para conectar Gmail
  const handleConnectGmail = async () => {
    if (!user?.email) return alert('Sessão expirada. Faça login novamente.')
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/gmail/auth-url?email=${encodeURIComponent(user.email)}`)
      const data = await res.json()
      if (data.url) window.location.href = data.url
    } catch (err) {
      console.error(err)
      alert('Erro ao conectar com o servidor.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0f1c] text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-black tracking-tighter bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            FUTURE EUA H2B
          </h1>
          <p className="text-gray-400 mt-2">Painel de Controle e Automação</p>
        </header>

        {message && (
          <div className="bg-blue-600/20 border border-blue-500 text-blue-200 p-4 rounded-xl mb-6 text-center animate-pulse">
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6">
          {/* CARD GMAIL */}
          <div className="bg-[#111827] border border-gray-800 p-6 rounded-2xl shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2">
                📧 Integração Gmail
              </h2>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${gmailConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                {gmailConnected ? 'CONECTADO' : 'DESCONECTADO'}
              </span>
            </div>
            
            <p className="text-gray-400 text-sm mb-6">
              Conecte seu Gmail para enviar candidaturas pelo seu próprio e-mail e receber as respostas automáticas dos empregadores.
            </p>

            {!gmailConnected ? (
              <button 
                onClick={handleConnectGmail}
                disabled={loading}
                className="w-full bg-white text-black font-bold py-3 rounded-xl hover:bg-gray-200 transition-all flex items-center justify-center gap-2"
              >
                {loading ? 'Carregando...' : '🔗 Conectar meu Gmail'}
              </button>
            ) : (
              <div className="bg-gray-900 p-4 rounded-xl border border-gray-800">
                <p className="text-xs text-gray-500 uppercase tracking-widest font-bold">Conta ativa</p>
                <p className="text-emerald-400 font-mono mt-1">{gmailEmail || user?.email}</p>
              </div>
            )}
          </div>

          {/* CARD PREMIUM */}
          <div className="bg-[#111827] border border-gray-800 p-6 rounded-2xl shadow-xl">
             <h2 className="text-xl font-bold mb-4">🔑 Status da Licença</h2>
             <div className="flex items-center justify-between">
                <p className="text-gray-400">Plano Atual:</p>
                <p className={isPremium ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>
                   {isPremium ? 'Premium (100 envios/dia)' : 'Gratuito (10 envios)'}
                </p>
             </div>
             {!isPremium && (
                <button className="mt-4 w-full bg-emerald-600 py-3 rounded-xl font-bold">💎 Ativar Chave Premium</button>
             )}
          </div>
        </div>

        <footer className="mt-12 text-center text-gray-600 text-sm">
          @futureeuah2b — {new Date().getFullYear()}
        </footer>
      </div>
    </div>
  )
}