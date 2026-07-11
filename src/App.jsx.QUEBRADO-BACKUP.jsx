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
  { id: 'winter-2026', label: '❄ Inverno 2026', short: 'Inverno', csvFile: '/vagas_inverno_2026_h2b.csv' },
  { id: 'summer-2026', label: '☀ Verão 2026', short: 'Verão', csvFile: null },
]

// ===================== TRADUÇÃO AUTOMÁTICA DE TEXTOS LONGOS =====================
async function googleTranslate(text) {
  if (!text || text.length < 3) return text
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url)
    const data = await res.json()
    if (data && data[0]) {
      return data[0].map(item => item[0]).join('')
    }
    return text
  } catch (err) {
    console.error("Erro na tradução:", err)
    return text
  }
}

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

function translateJobTitleToPt(title = '') {
  const t = title.toLowerCase().trim()
  if (!t || t.includes('skip to main')) return ''

  // Mapeamento Direto e Específico (Os que faltavam no seu print)
  if (t.includes('site preparation')) return 'Trabalhador de preparação de terreno'
  if (t.includes('door/window') || t.includes('window installer')) return 'Instalador de portas e janelas'
  if (t.includes('equipment operator')) return 'Operador de equipamentos'
  if (t.includes('landscape laborer') || t.includes('landscaping')) return 'Trabalhador de paisagismo'
  if (t.includes('forestry worker') || t.includes('forest worker')) return 'Trabalhador florestal'
  if (t.includes('housekeep') || t.includes('room attendant')) return 'Camareira / Arrumação'
  if (t.includes('cleaner') || t.includes('janitor')) return 'Auxiliar de limpeza'
  if (t.includes('construction laborer')) return 'Trabalhador de construção'
  if (t.includes('cook') || t.includes('prep cook')) return 'Cozinheiro'
  if (t.includes('dishwash')) return 'Lavador de pratos'
  if (t.includes('server') || t.includes('waiter')) return 'Garçom / Atendente'
  if (t.includes('oyster') || t.includes('shuck')) return 'Processador de ostras'
  if (t.includes('general laborer') || t.includes('laborer')) return 'Trabalhador geral'
  if (t.includes('maintenance')) return 'Auxiliar de manutenção'
  if (t.includes('tent') || t.includes('event')) return 'Montador de tendas / eventos'
  if (t.includes('tree trim')) return 'Podador de árvores'
  if (t.includes('driver') || t.includes('truck')) return 'Motorista'
  if (t.includes('packer') || t.includes('packag')) return 'Empacotador'
  if (t.includes('warehouse')) return 'Trabalhador de depósito'
  if (t.includes('clerk') || t.includes('receptionist')) return 'Recepcionista / Atendente'
  if (t.includes('operator')) return 'Operador'
  if (t.includes('worker')) return 'Trabalhador'
  
  return title // Se não achar nada, mantém o original
}

function normalizeSeasonId(value = '') {
  const raw = String(value || '').trim()
  return (raw === 'winter-2025' || !raw) ? 'winter-2026' : raw
}

function detectCategory(title = '') {
  const t = title.toLowerCase()
  if (t.includes('housekeep') || t.includes('hotel')) return 'Hotelaria'
  if (t.includes('cook') || t.includes('kitchen')) return 'Cozinha'
  if (t.includes('server') || t.includes('waiter') || t.includes('restaurant')) return 'Restaurantes'
  if (t.includes('landscape') || t.includes('grounds')) return 'Landscaping'
  if (t.includes('construct') || t.includes('laborer')) return 'Construção'
  return 'Outros'
}

function formatState(state = '') { return state.trim().toUpperCase() }
function formatDate(value = '') { return value || 'Não informada' }
function formatWageValue(value = '') { return value ? `US$ ${value}/h` : 'A combinar' }
function parseVacancies(value = '') { return parseInt(String(value).replace(/[^\d]/g, ''), 10) || 0 }

function parseJobFromCsv(row, index, seasonId) {
  const caseNumber = getRowValue(row, ['Case Number', 'case_number'])
  const employer = getRowValue(row, ['Business Name', 'employer'])
  const state = formatState(getRowValue(row, ['Worksite State', 'state']))
  const title = getRowValue(row, ['Cargo', 'title'])
  const description = getRowValue(row, ['Descricao_Vaga', 'description'])
  const vacancies = parseVacancies(getRowValue(row, ['Qtd_Vagas', 'vacancies']))
  const wage = getRowValue(row, ['Wage_Hora', 'wage'])

  return {
    seasonId, id: `${seasonId}-${caseNumber || index}`,
    caseNumber, employer, state, vacancies, wage: formatWageValue(wage),
    title, description, category: detectCategory(title),
    location: state, fullLocation: `${state}, USA`,
    contact: getRowValue(row, ['Email', 'contact']),
    phone: getRowValue(row, ['Telefone', 'phone']),
    agentAttorneyName: getRowValue(row, ['Agent Attorney Name', 'agent_attorney_name']),
    randomizationGroup: getRowValue(row, ['Randomization Group', 'randomization_group']),
    startDate: formatDate(getRowValue(row, ['Begin Date', 'begin_date'])),
    endDate: formatDate(getRowValue(row, ['Final Date', 'end_date'])),
    visaType: 'H-2B'
  }
}

// ====================== COMPONENTES INTERNOS ======================

function TranslatedDescription({ text }) {
  const [translated, setTranslated] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!text) return
    setLoading(true)
    googleTranslate(text).then(res => {
      setTranslated(res)
      setLoading(false)
    })
  }, [text])

  if (loading) return <p style={{ opacity: 0.6, fontStyle: 'italic' }}>⏳ Traduzindo descrição para português...</p>
  return <p>{translated || text}</p>
}

function loadUserSession() { try { const raw = localStorage.getItem(USER_SESSION_KEY); return raw ? JSON.parse(raw) : null } catch { return null } }
function createQueueId() { return `QUEUE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function createSentId() { return `SENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function randomDelay(fastMode) { return fastMode ? 5000 : 90000 }
function formatSeconds(s) { const m = Math.floor(s / 60); const sec = s % 60; return `${m}min ${sec}s` }
function getInitials(name = '') { return (name[0] || 'F') + (name[1] || 'E') }
function progressColor(p) { return p < 35 ? 'green' : p < 75 ? 'yellow' : 'red' }

// ====================== COMPONENTE PRINCIPAL ======================
export default function App() {
  const savedUser = useMemo(() => loadUserSession(), [])
  const [page, setPage] = useState(savedUser ? 'dashboard' : 'home')
  const [user, setUser] = useState(savedUser)
  const [logged, setLogged] = useState(!!savedUser)
  const [selectedSeason, setSelectedSeason] = useState('winter-2026')
  const [sentLogs, setSentLogs] = useState([])
  const [queue, setQueue] = useState([])
  const [allJobs, setAllJobs] = useState([])
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [selectedIds, setSelectedIds] = useState([])
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('Todas')
  const [stateFilter, setStateFilter] = useState('Todos')
  const [queueRunning, setQueueRunning] = useState(false)
  const [activeSend, setActiveSend] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [fastMode, setFastMode] = useState(false)
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [loginError, setLoginError] = useState('')
  const [activationKey, setActivationKey] = useState('')
  const [activationStatus, setActivationStatus] = useState(null)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [jobMessage, setJobMessage] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const dataLoadedRef = useRef(false)
  const currentUserIdRef = useRef(null)

  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const [loadingGmail, setLoadingGmail] = useState(false)

  const loadFromSupabase = useCallback(async (userId) => {
    if (!userId) return
    setSyncing(true); dataLoadedRef.current = false
    try {
      const { data, error } = await supabase.from('users').select('*').eq('id', userId).single()
      if (data) {
        setUser(data)
        setSentLogs(data.sent_logs || [])
        setQueue(data.queue_data || [])
        setGmailConnected(!!data.gmail_connected)
        setGmailEmail(data.gmail_email || '')
        dataLoadedRef.current = true
      }
    } catch (err) { console.error(err) } finally { setSyncing(false) }
  }, [])

  const saveToSupabase = useCallback(async (userId, nsl, nq, ns) => {
    if (!userId || !dataLoadedRef.current) return
    await supabase.from('users').update({ sent_logs: nsl, queue_data: nq, selected_season: ns }).eq('id', userId)
  }, [])

  useEffect(() => {
    async function load() {
      setLoadingJobs(true)
      try {
        const r = await fetch('/vagas_inverno_2026_h2b.csv')
        const csv = await r.text()
        const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true })
        const jobs = parsed.data
          .filter(row => getRowValue(row, ['Case Number', 'case_number']))
          .map((row, i) => parseJobFromCsv(row, i, 'winter-2026'))
        setAllJobs(jobs)
      } catch (e) { console.error(e) } finally { setLoadingJobs(false) }
    }
    load()
  }, [])

  const jobs = useMemo(() => allJobs.filter(j => j.seasonId === selectedSeason), [allJobs, selectedSeason])
  const totalSeasonJobs = jobs.length
  const filteredJobs = useMemo(() => jobs.filter(j => {
    const txt = `${j.title} ${j.employer} ${j.state}`.toLowerCase()
    return txt.includes(search.toLowerCase()) && (categoryFilter === 'Todas' || j.category === categoryFilter) && (stateFilter === 'Todos' || j.state === stateFilter)
  }), [jobs, search, categoryFilter, stateFilter])

  const visibleJobs = filteredJobs.slice(0, 100)
  const selectedJob = jobs.find(j => j.id === selectedJobId) || visibleJobs[0] || null
  const isPremium = user?.premium === true
  const todaySent = sentLogs.length // Simplificado para o dashboard
  const dailyRemaining = 100 - todaySent
  const systemStatus = "Ativo"
  const progress = totalSeasonJobs > 0 ? Math.round((sentLogs.length / totalSeasonJobs) * 100) : 0
  const barColor = progressColor(progress)
  const sentIds = new Set(sentLogs.map(l => l.jobId))
  const queuedIds = new Set(queue.map(q => q.jobId))

  const handleLogin = async (e) => {
    e.preventDefault(); setLoginError('')
    const { data, error } = await supabase.from('users').select('*').eq('email', loginForm.email).maybeSingle()
    if (data && data.password === loginForm.password) {
      setUser(data); setLogged(true); setPage('dashboard'); loadFromSupabase(data.id)
    } else { setLoginError('E-mail ou senha incorretos.') }
  }

  const handleConnectGmail = async () => {
    const url = `https://future-eua-h2b-api.onrender.com/api/gmail/auth-url?email=${user.email}`
    window.location.href = url
  }

  function toggleSelect(jobId) {
    if (sentIds.has(jobId) || queuedIds.has(jobId)) return
    setSelectedIds(prev => prev.includes(jobId) ? prev.filter(id => id !== jobId) : [...prev, jobId])
  }

  function sendSelected() {
    const newItems = selectedIds.map(id => {
      const j = jobs.find(x => x.id === id)
      return { id: createQueueId(), jobId: j.id, jobTitle: j.title, employer: j.employer, contact: j.contact, status: 'queued' }
    })
    setQueue(prev => [...prev, ...newItems]); setSelectedIds([]); setQueueRunning(true)
  }

  return (
    <div className="app">
      {page === 'home' && <Home onLogin={() => setPage('login')} />}
      
      {page === 'login' && (
        <AuthShell>
          <form className="auth-card" onSubmit={handleLogin}>
            <BrandBlock />
            <h2>Login</h2>
            {loginError && <div className="alert error">{loginError}</div>}
            <input type="email" placeholder="E-mail" onChange={e => setLoginForm({...loginForm, email: e.target.value})} />
            <input type="password" placeholder="Senha" onChange={e => setLoginForm({...loginForm, password: e.target.value})} />
            <button className="primary-btn">Entrar</button>
          </form>
        </AuthShell>
      )}

      {page === 'dashboard' && (
        <Dashboard 
          user={user} totalSeasonJobs={totalSeasonJobs} sentCount={sentLogs.length} 
          remainingCount={totalSeasonJobs - sentLogs.length} progress={progress} barColor={barColor}
          systemStatus={systemStatus} dailyRemaining={dailyRemaining} gmailConnected={gmailConnected}
          gmailEmail={gmailEmail} handleConnectGmail={handleConnectGmail}
          onJobs={() => setPage('jobs')} onLogout={() => setPage('home')}
        />
      )}

      {page === 'jobs' && (
        <JobsPage 
          user={user} visibleJobs={visibleJobs} filteredJobs={filteredJobs} 
          selectedJob={selectedJob} setSelectedJobId={setSelectedJobId}
          selectedIds={selectedIds} toggleSelect={toggleSelect} sendSelected={sendSelected}
          sentIds={sentIds} queuedIds={queuedIds} search={search} setSearch={setSearch}
          onDashboard={() => setPage('dashboard')}
        />
      )}

      {page !== 'home' && <GlobalFooter />}
    </div>
  )
}

// ====================== COMPONENTES DE INTERFACE ======================

function Home({ onLogin }) {
  return (
    <main className="home home-premium">
      <div className="home-overlay" />
      <section className="home-stage">
        <BrandBlock />
        <div className="home-hero-card">
          <h2>Dashboard Future EUA H2B - Temporada 2026</h2>
          <button className="primary-btn" onClick={onLogin}>Acessar Sistema</button>
        </div>
      </section>
    </main>
  )
}

function Dashboard({ user, totalSeasonJobs, sentCount, remainingCount, progress, barColor, systemStatus, dailyRemaining, gmailConnected, gmailEmail, handleConnectGmail, onJobs, onLogout }) {
  return (
    <main className="dashboard-page">
      <header className="topbar">
        <BrandBlock />
        <button onClick={onLogout}>Sair</button>
      </header>
      <section className="container">
        <div className="stats-grid">
          <StatCard title="Total Inverno 2026" value={`${totalSeasonJobs} vagas`} />
          <StatCard title="Candidaturas Enviadas" value={sentCount} />
          <StatCard title="Vagas Restantes" value={remainingCount} />
        </div>
        
        <section className="panel" style={{ marginTop: 20 }}>
          <h3>Conexão Gmail</h3>
          {gmailConnected ? <p>✅ Conectado: {gmailEmail}</p> : <button onClick={handleConnectGmail}>🔗 Conectar Gmail</button>}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Progresso da Temporada</h3><strong>{progress}%</strong></div>
          <div className="life-bar"><div className={`life-fill ${barColor}`} style={{ width: `${progress}%` }} /></div>
        </section>

        <button className="primary-btn" onClick={onJobs}>Abrir Lista de Vagas</button>
      </section>
    </main>
  )
}

function JobsPage({ visibleJobs, filteredJobs, selectedJob, setSelectedJobId, selectedIds, toggleSelect, sendSelected, sentIds, queuedIds, search, setSearch, onDashboard }) {
  return (
    <main className="jobs-page">
      <header className="topbar"><button onClick={onDashboard}>Voltar ao Dashboard</button></header>
      <section className="container">
        <input className="search-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar empresa ou cargo..." />
        
        <div className="jobs-selection-summary">
          <strong>{selectedIds.length} selecionadas</strong>
          <button className="primary-btn" onClick={sendSelected}>Enviar Candidaturas</button>
        </div>

        <div className="jobs-two-columns">
          <div className="jobs-list-panel">
            {visibleJobs.map(j => (
              <div key={j.id} className={`job-master-item ${selectedJob?.id === j.id ? 'active' : ''}`} onClick={() => setSelectedJobId(j.id)}>
                <input type="checkbox" checked={selectedIds.includes(j.id)} onChange={() => toggleSelect(j.id)} />
                <div>
                  <strong>{translateJobTitleToPt(j.title)}</strong>
                  <p>{j.employer} - {j.state}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="jobs-detail-panel">
            {selectedJob && (
              <div className="detail-card">
                <h2>{translateJobTitleToPt(selectedJob.title)}</h2>
                <p><strong>Empresa:</strong> {selectedJob.employer}</p>
                <p><strong>Estado:</strong> {selectedJob.state}</p>
                <p><strong>Vagas disponíveis:</strong> {selectedJob.vacancies}</p>
                <p><strong>Salário:</strong> {selectedJob.wage}</p>
                <p><strong>Case Number:</strong> {selectedJob.caseNumber}</p>
                <hr />
                <h3>Descrição oficial</h3>
                <TranslatedDescription text={selectedJob.description} />
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

function BrandBlock() { return <div className="brand-block"><h1>FUTURE EUA H2B</h1></div> }
function AuthShell({ children }) { return <div className="auth-shell">{children}</div> }
function StatCard({ title, value }) { return <div className="stat-card"><span>{title}</span><strong>{value}</strong></div> }
function GlobalFooter() { return <footer className="global-footer"><p>© 2026 Future EUA H2B - seasonaljobs.dol.gov</p></footer> }