import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Papa from 'papaparse'
import { supabase } from './supabase'

const DAILY_LIMIT = 100
const DEMO_LIMIT = 10
const FREE_ACCESS_KEY = 'FREE-H2B-2026'
const CONTACT_LINK = 'https://wa.me/5575999866105?text=Olá,%20quero%20comprar%20a%20chave%20Premium.%20Meu%20e-mail%20é:%20'
const API_URL = import.meta.env.VITE_API_URL || 'https://future-eua-h2b-api.onrender.com'
const USER_SESSION_KEY = 'h2b-user-session'

const seasons = [
  { id: 'winter-2026', label: '❄ Inverno 2026', short: 'Inverno', csvFile: '/vagas_inverno_2026_h2b.csv' },
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
  // Mapeamento flexível para aceitar variações de nomes de colunas da nova planilha
  const caseNumber = getRowValue(row, ['Case number', 'CASE_NUMBER', 'CaseNumber', 'Job Order Number'])
  const employer = getRowValue(row, ['Nome da empresa', 'EMPLOYER_NAME', 'Employer', 'Company Name'])
  const state = formatState(getRowValue(row, ['Estado', 'EMPLOYER_STATE', 'State']))
  const title = getRowValue(row, ['Título do cargo', 'JOB_TITLE', 'Job Title', 'Titulo do cargo'])
  const contact = getRowValue(row, ['E-mail do empregador', 'EMAIL', 'Employer Email', 'Contact Email'])
  const phone = getRowValue(row, ['Telefone do empregador', 'PHONE', 'Employer Phone'])
  const description = getRowValue(row, ['Responsabilidades do cargo', 'JOB_DUTIES', 'Description'])
  const city = getRowValue(row, ['Cidade', 'EMPLOYER_CITY', 'City'])
  const visaType = getRowValue(row, ['Tipo do visto', 'VISA_CLASS']) || 'H-2B'
  const wageRaw = getRowValue(row, ['wage_per_hour', 'WAGE_RATE_FROM', 'Wage'])
  const startDate = formatDate(getRowValue(row, ['Data de início', 'BEGIN_DATE', 'Start Date']))
  const endDate = formatDate(getRowValue(row, ['Data de fim', 'END_DATE', 'End Date']))
  const agent = getRowValue(row, ['Nome do advogado do agente', 'ATTORNEY_AGENT_NAME'])

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
  if (t.includes('cook')) return 'Cozinheiro'
  if (t.includes('housekeep')) return 'Camareira / Arrumação'
  if (t.includes('landscape')) return 'Trabalhador de paisagismo'
  return title
}

function buildPortugueseJobDescription(job) {
  if (!job) return 'Selecione uma vaga para ver os detalhes.'
  return `A vaga de ${translateJobTitleToPt(job.title)} em ${job.fullLocation}. Salário: ${job.wageDetail}. Visto: ${job.visaType}.`
}

function getLicenseKey(user = {}) {
  return user?.access_key || user?.accessKey || user?.premium_access_key || ''
}

// ====================== COMPONENTE PRINCIPAL ======================
export default function App() {
  const savedUser = useMemo(() => loadUserSession(), [])
  const [page, setPage] = useState(savedUser ? 'dashboard' : 'home')
  const [user, setUser] = useState(savedUser)
  const [logged, setLogged] = useState(!!savedUser)

  // Mudança para Inverno 2026 como padrão
  const [selectedSeason, setSelectedSeason] = useState('winter-2026')
  const [sentLogs, setSentLogs] = useState([])
  const [queue, setQueue] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [allJobs, setAllJobs] = useState([])
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [loginError, setLoginError] = useState('')
  const [syncing, setSyncing] = useState(false)

  const dataLoadedRef = useRef(false)
  const currentUserIdRef = useRef(null)

  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const [loadingGmail, setLoadingGmail] = useState(false)

  const [registerForm, setRegisterForm] = useState({
    name: '', email: '', password: '', phone: '', address: '', cep: '', state: '', country: '',
    resumeFile: null, coverLetterFile: null, resumeFileName: '', coverLetterFileName: '',
    employerMessage: 'To the Hiring Manager,\n\nI am writing to express my strong interest in the seasonal position available at your company. I am available and ready to work.\n\nBest regards,',
  })

  const [registerErrors, setRegisterErrors] = useState({})
  const [registerStatus, setRegisterStatus] = useState(null)
  const [profileForm, setProfileForm] = useState(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('Todas')
  const [stateFilter, setStateFilter] = useState('Todos')
  const [jobMessage, setJobMessage] = useState(null)
  const [queueRunning, setQueueRunning] = useState(false)
  const [activeSend, setActiveSend] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [fastMode, setFastMode] = useState(false)
  const [activationKey, setActivationKey] = useState('')
  const [activationStatus, setActivationStatus] = useState(null)
  const [uploadingFiles, setUploadingFiles] = useState(false)

  const loadFromSupabase = useCallback(async (userId) => {
    if (!userId) return
    setSyncing(true)
    dataLoadedRef.current = false
    try {
      const { data, error } = await supabase.from('users').select('*').eq('id', userId).single()
      if (error) throw error
      if (data) {
        setUser(data)
        localStorage.setItem(USER_SESSION_KEY, JSON.stringify(data))
        setSentLogs(Array.isArray(data.sent_logs) ? data.sent_logs : [])
        setQueue(Array.isArray(data.queue_data) ? data.queue_data : [])
        // Se o banco tiver uma temporada salva, usa ela, senão mantém winter-2026
        if (data.selected_season) setSelectedSeason(data.selected_season)
        
        setGmailConnected(!!data.gmail_connected)
        setGmailEmail(data.gmail_email || '')

        setTimeout(() => { dataLoadedRef.current = true; }, 500)
      }
    } catch (err) { console.error('❌ Erro ao carregar dados:', err.message); }
    finally { setSyncing(false); }
  }, [])

  const saveToSupabase = useCallback(async (userId, newSentLogs, newQueue, newSeason) => {
    if (!userId || !dataLoadedRef.current) return
    try {
      await supabase.from('users').update({ 
        sent_logs: newSentLogs, 
        queue_data: newQueue, 
        selected_season: newSeason 
      }).eq('id', userId)
    } catch (err) { console.warn('❌ Erro ao salvar no Supabase:', err.message); }
  }, [])

  // Efeito para carregar as vagas do CSV
  useEffect(() => {
    async function loadAllSeasons() {
      setLoadingJobs(true)
      const loadedJobs = []
      for (const season of seasons) {
        if (!season.csvFile) continue
        try {
          const response = await fetch(season.csvFile)
          const csvText = await response.text()
          const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
          // Filtro robusto: só aceita se tiver Case Number ou Employer Name
          const validRows = parsed.data.filter(r => 
            getRowValue(r, ['Case number', 'CASE_NUMBER', 'Employer', 'Nome da empresa'])
          )
          loadedJobs.push(...validRows.map((r, i) => parseJobFromCsv(r, i, season.id)))
        } catch (e) { console.error(`Erro ao carregar CSV ${season.id}:`, e); }
      }
      setAllJobs(loadedJobs)
      setLoadingJobs(false)
    }
    loadAllSeasons()
  }, [])

  // Detecta retorno do Gmail OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('status') === 'sucesso') {
      alert('✅ Gmail conectado! Respostas automáticas agora chegarão no seu e-mail.')
      window.history.replaceState({}, document.title, window.location.pathname)
      if (user?.id) loadFromSupabase(user.id)
    }
  }, [user?.id, loadFromSupabase])

  useEffect(() => {
    if (user?.id && user.id !== currentUserIdRef.current) {
      currentUserIdRef.current = user.id
      loadFromSupabase(user.id)
    }
  }, [user?.id, loadFromSupabase])

  useEffect(() => {
    if (!user?.id || !dataLoadedRef.current) return
    const timer = setTimeout(() => { saveToSupabase(user.id, sentLogs, queue, selectedSeason) }, 2000)
    return () => clearTimeout(timer)
  }, [sentLogs, queue, selectedSeason, user?.id, saveToSupabase])

  const jobs = useMemo(() => allJobs.filter(j => j.seasonId === selectedSeason), [allJobs, selectedSeason])
  const isPremium = user?.premium === true
  const totalSentEver = sentLogs.length
  const todayKey = getLocalDateKey()
  const todayUsed = sentLogs.filter(l => getLocalDateKey(l.sentAt) === todayKey).length + queue.filter(i => getLocalDateKey(i.createdAt) === todayKey).length
  const activeLimit = isPremium ? DAILY_LIMIT : DEMO_LIMIT
  const dailyRemaining = Math.max(0, activeLimit - todayUsed)
  const isDemoBlocked = !isPremium && totalSentEver >= DEMO_LIMIT
  const sentIds = useMemo(() => new Set(sentLogs.map(l => l.jobId)), [sentLogs])
  const queuedIds = useMemo(() => new Set(queue.map(i => i.jobId)), [queue])

  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const text = `${job.title} ${job.employer} ${job.location}`.toLowerCase()
      return text.includes(search.toLowerCase()) && 
             (categoryFilter === 'Todas' || job.category === categoryFilter) &&
             (stateFilter === 'Todos' || job.state === stateFilter)
    })
  }, [jobs, search, categoryFilter, stateFilter])

  const visibleJobs = filteredJobs.slice(0, 200)
  const selectedJob = jobs.find(j => j.id === selectedJobId) || visibleJobs[0] || null

  // ===================== LÓGICA DE FILA E ENVIO =====================
  useEffect(() => {
    if (!queueRunning || activeSend || isDemoBlocked) return
    const next = queue.find(i => i.status === 'queued')
    if (!next) { setQueueRunning(false); return }

    const dueAt = Date.now() + randomDelay(fastMode)
    setQueue(prev => prev.map(i => i.id === next.id ? { ...i, status: 'waiting', dueAt } : i))
    setActiveSend({ queueId: next.id, dueAt })
  }, [queueRunning, activeSend, queue, fastMode, isDemoBlocked])

  useEffect(() => {
    if (!activeSend) return
    const item = queue.find(i => i.id === activeSend.queueId)
    if (!item) { setActiveSend(null); return }

    const remaining = Math.max(0, activeSend.dueAt - Date.now())
    const timer = setTimeout(async () => {
      const job = allJobs.find(j => j.id === item.jobId)
      const attachments = []
      if (user?.resume1_path) attachments.push({ url: user.resume1_path, filename: 'curriculo.pdf' })
      if (user?.cover_letter_path) attachments.push({ url: user.cover_letter_path, filename: 'carta_apresentacao.pdf' })

      try {
        const response = await fetch(`${API_URL}/api/send-candidature`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user?.id, // CRUCIAL PARA O GMAIL FUNCIONAR
            candidateName: user?.name,
            candidateEmail: user?.email,
            employerEmail: job?.contact,
            jobTitle: job?.title,
            employerName: job?.employer,
            messageBody: user?.employer_message || user?.employerMessage,
            attachments,
            licenseKey: getLicenseKey(user),
          }),
        })

        const resData = await response.json()
        if (!response.ok || !resData.ok) throw new Error(resData.error || 'Falha no envio')

        const newLog = {
          id: createSentId(), jobId: item.jobId, jobTitle: item.jobTitle,
          employer: item.employer, contact: item.contact,
          seasonId: item.seasonId, sentAt: new Date().toISOString(),
        }

        setSentLogs(prev => [...prev, newLog])
        setQueue(prev => prev.filter(i => i.id !== item.id))
        setJobMessage({ type: 'success', text: `✅ Enviada: ${item.jobTitle}` })
      } catch (err) {
        console.error('Erro no envio:', err)
        setQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'queued' } : i))
      } finally {
        setActiveSend(null)
      }
    }, remaining)

    return () => clearTimeout(timer)
  }, [activeSend, queue, allJobs, user])

  useEffect(() => {
    if (!activeSend) { setCountdown(0); return }
    const interval = setInterval(() => setCountdown(Math.max(0, Math.ceil((activeSend.dueAt - Date.now()) / 1000))), 1000)
    return () => clearInterval(interval)
  }, [activeSend])

  // ===================== FUNÇÕES DE INTERAÇÃO =====================
  const handleConnectGmail = async () => {
    if (!user?.email) return
    setLoadingGmail(true)
    try {
      const res = await fetch(`${API_URL}/api/gmail/auth-url?email=${encodeURIComponent(user.email)}`)
      const data = await res.json()
      if (data.url) window.location.href = data.url
    } catch (err) { alert('Erro ao conectar com Google Cloud.'); }
    finally { setLoadingGmail(false); }
  }

  function sendSelected() {
    if (isDemoBlocked || selectedIds.length === 0) return
    const selJobs = selectedIds.map(id => jobs.find(j => j.id === id)).filter(Boolean)
    const newItems = selJobs.map(job => ({
      id: createQueueId(), jobId: job.id, jobTitle: job.title,
      employer: job.employer, contact: job.contact,
      seasonId: selectedSeason, createdAt: new Date().toISOString(), status: 'queued',
    }))
    setQueue(p => [...p, ...newItems])
    setSelectedIds([])
    setQueueRunning(true)
  }

  // Componentes visuais simplificados para manter o código limpo
  const TopBarComp = () => (
    <header className="topbar">
      <div className="topbar-brand"><RotatingLogo /><div><strong>FUTURE EUA H2B</strong><span>Temporada 2026</span></div></div>
      <nav><button onClick={() => setPage('dashboard')}>Dashboard</button><button onClick={() => setPage('jobs')}>Vagas</button><button onClick={() => setPage('profile')}>Perfil</button></nav>
      <button className="logout-btn" onClick={() => { localStorage.removeItem(USER_SESSION_KEY); window.location.reload(); }}>Sair</button>
    </header>
  )

  return (
    <div className="app">
      {syncing && <div className="sync-badge">🔄 Sincronizando dados...</div>}

      {page === 'home' && <Home onRegister={() => setPage('register')} onLogin={() => setPage('login')} />}

      {page === 'login' && (
        <AuthShell>
          <form className="auth-card" onSubmit={async (e) => {
            e.preventDefault();
            const { data } = await supabase.from('users').select('*').eq('email', loginForm.email.toLowerCase()).eq('password', loginForm.password).single();
            if (data) { setUser(data); setLogged(true); localStorage.setItem(USER_SESSION_KEY, JSON.stringify(data)); setPage('dashboard'); }
            else alert('Dados incorretos');
          }}>
            <BrandBlock />
            <h2>Login</h2>
            <input type="email" placeholder="E-mail" onChange={e => setLoginForm({...loginForm, email: e.target.value})} />
            <input type="password" placeholder="Senha" onChange={e => setLoginForm({...loginForm, password: e.target.value})} />
            <button className="primary-btn" type="submit">Entrar</button>
            <button className="text-btn" onClick={() => setPage('home')}>Voltar</button>
          </form>
        </AuthShell>
      )}

      {page === 'dashboard' && (
        <main className="dashboard-page">
          <TopBarComp />
          <section className="container">
            <div className="dashboard-hero">
              <h2>Olá, {user?.name}!</h2>
              <div className="season-box">
                <select value={selectedSeason} onChange={e => setSelectedSeason(e.target.value)}>
                  {seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>

            <section className="panel gmail-panel">
              <div className="panel-head">
                <h3>📧 Conexão Gmail</h3>
                <span className={`status-badge ${gmailConnected ? 'connected' : ''}`}>
                  {gmailConnected ? 'CONECTADO' : 'DESCONECTADO'}
                </span>
              </div>
              {!gmailConnected ? (
                <button className="primary-btn gmail-btn" onClick={handleConnectGmail} disabled={loadingGmail}>
                  {loadingGmail ? '⏳ Conectando...' : '🔗 Conectar meu Gmail para receber respostas'}
                </button>
              ) : (
                <p>Candidaturas enviadas via: <strong>{gmailEmail || user?.email}</strong></p>
              )}
            </section>

            <div className="stats-grid">
              <StatCard title="Vagas Disponíveis" value={jobs.length} />
              <StatCard title="Enviadas" value={sentLogs.filter(l => l.seasonId === selectedSeason).length} />
              <StatCard title="Restante Hoje" value={dailyRemaining} />
              <StatCard title="Fila Ativa" value={queue.length} />
            </div>

            <div className="actions-row">
              <button className="primary-btn" onClick={() => setPage('jobs')}>Abrir Painel de Vagas</button>
            </div>
          </section>
        </main>
      )}

      {page === 'jobs' && (
        <JobsPage 
          user={user} jobs={jobs} visibleJobs={visibleJobs} filteredJobs={filteredJobs}
          selectedJob={selectedJob} setSelectedJobId={setSelectedJobId}
          selectedIds={selectedIds} toggleSelect={(id) => setSelectedIds(p => p.includes(id) ? p.filter(x => x!==id) : [...p, id])}
          sendSelected={sendSelected} sentIds={sentIds} queuedIds={queuedIds}
          search={search} setSearch={setSearch} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter}
          stateFilter={stateFilter} setStateFilter={setStateFilter} states={['Todos', ...new Set(jobs.map(j => j.state))]}
          categories={['Todas', ...new Set(jobs.map(j => j.category))]}
          dailyRemaining={dailyRemaining} queueRunning={queueRunning} setQueueRunning={setQueueRunning}
          activeSend={activeSend} countdown={countdown} fastMode={fastMode} setFastMode={setFastMode}
          onDashboard={() => setPage('dashboard')} loadingJobs={loadingJobs} isDemoBlocked={isDemoBlocked}
        />
      )}

      {page === 'profile' && (
        <AuthShell>
          <div className="auth-card large">
            <h2>Configurações do Perfil</h2>
            <div className="gmail-integration-box" style={{margin: '20px 0', padding: '15px', border: '1px solid #ccc', borderRadius: '8px'}}>
               <h4>Gmail API</h4>
               {gmailConnected ? <p>✅ Conectado: {gmailEmail}</p> : <button className="primary-btn" onClick={handleConnectGmail}>Conectar Gmail</button>}
            </div>
            <textarea 
              rows="6" 
              defaultValue={user?.employer_message} 
              onBlur={async (e) => {
                const val = e.target.value;
                await supabase.from('users').update({employer_message: val}).eq('id', user.id);
              }}
            />
            <button className="primary-btn" onClick={() => setPage('dashboard')}>Voltar ao Dashboard</button>
          </div>
        </AuthShell>
      )}

      <GlobalFooter />
    </div>
  )
}

// ===================== COMPONENTES DE APOIO =====================
function RotatingLogo() { return <div className="rotating-logo"><img src="/logo-br-us.png" alt="Logo" style={{width: 40}} /></div> }
function BrandBlock() { return <div className="brand-block"><h1>FUTURE EUA H2B</h1></div> }
function AuthShell({ children }) { return <div className="auth-shell">{children}</div> }
function Home({ onRegister, onLogin }) { return <div className="home-stage"><h1>FUTURE EUA H2B</h1><button onClick={onRegister}>Cadastrar</button><button onClick={onLogin}>Entrar</button></div> }
function StatCard({ title, value }) { return <div className="stat-card"><span>{title}</span><strong>{value}</strong></div> }
function InfoLine({ label, value }) { return <div className="info-line"><span>{label}</span><strong>{value}</strong></div> }

function GlobalFooter() {
  return (
    <footer className="global-footer">
      <p>© 2026 Future EUA H2B - Todos os direitos reservados</p>
    </footer>
  )
}

// O componente JobsPage continua seguindo a estrutura do seu código original, 
// mas utilizando as funções de filtro e envio corrigidas acima.
function JobsPage({ ...props }) {
  return (
    <main className="jobs-page">
      <div className="container">
        <button onClick={props.onDashboard}>⬅ Voltar</button>
        <div className="jobs-top-filters">
           <input placeholder="Buscar vaga..." onChange={e => props.setSearch(e.target.value)} />
           <select onChange={e => props.setCategoryFilter(e.target.value)}>{props.categories.map(c => <option key={c}>{c}</option>)}</select>
        </div>
        <div className="jobs-selection-summary">
          <strong>{props.selectedIds.length} selecionadas</strong>
          <button className="primary-btn" onClick={props.sendSelected} disabled={props.selectedIds.length === 0}>Enviar Candidaturas</button>
        </div>
        <div className="jobs-queue-bar">
           <label><input type="checkbox" checked={props.queueRunning} onChange={e => props.setQueueRunning(e.target.checked)} /> Processar Fila</label>
           {props.activeSend && <span> Próximo em: {props.countdown}s</span>}
        </div>
        <div className="jobs-two-columns">
           <div className="jobs-list-scroll">
              {props.visibleJobs.map(job => (
                <div key={job.id} className={`job-master-item ${props.selectedJob?.id === job.id ? 'active' : ''}`} onClick={() => props.setSelectedJobId(job.id)}>
                   <input type="checkbox" checked={props.selectedIds.includes(job.id)} onChange={() => props.toggleSelect(job.id)} />
                   <div>
                     <strong>{job.title}</strong>
                     <p>{job.employer} - {job.location}</p>
                   </div>
                   {props.sentIds.has(job.id) && <span className="tag-sent">Enviado</span>}
                </div>
              ))}
           </div>
           <div className="jobs-detail-panel">
              {props.selectedJob ? (
                <div className="detail-card">
                  <h2>{props.selectedJob.title}</h2>
                  <InfoLine label="Empresa" value={props.selectedJob.employer} />
                  <InfoLine label="Local" value={props.selectedJob.fullLocation} />
                  <InfoLine label="Salário" value={props.selectedJob.wageDetail} />
                  <InfoLine label="Email" value={props.selectedJob.contact} />
                  <p>{buildPortugueseJobDescription(props.selectedJob)}</p>
                </div>
              ) : <p>Selecione uma vaga</p>}
           </div>
        </div>
      </div>
    </main>
  )
}