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

// ====================== COMPONENTE PRINCIPAL ======================
export default function App() {
  const savedUser = useMemo(() => loadUserSession(), [])
  const [page, setPage] = useState(savedUser ? 'dashboard' : 'home')
  const [user, setUser] = useState(savedUser)
  const [logged, setLogged] = useState(!!savedUser)

  const [selectedSeason, setSelectedSeason] = useState('winter-2025')
  const [sentLogs, setSentLogs] = useState([])
  const [queue, setQueue] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [allJobs, setAllJobs] = useState([])
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [loginError, setLoginError] = useState('')
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryStatus, setRecoveryStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)

  const dataLoadedRef = useRef(false)
  const currentUserIdRef = useRef(null)

  // ESTADOS CONEXÃO GMAIL API
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const [loadingGmail, setLoadingGmail] = useState(false)

  const [registerForm, setRegisterForm] = useState({
    name: '', email: '', password: '', phone: '',
    address: '', cep: '', state: '', country: '',
    resumeFile: null, coverLetterFile: null,
    resumeFileName: '', coverLetterFileName: '',
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
    console.log('🔄 Carregando dados do usuário', userId)
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
        setSelectedSeason(data.selected_season || 'winter-2025')
        
        // Sincroniza estado de conexão do Gmail do banco de dados
        setGmailConnected(!!data.gmail_connected)
        setGmailEmail(data.gmail_email || '')

        setTimeout(() => { dataLoadedRef.current = true; console.log('✅ Sincronização liberada'); }, 500)
      }
    } catch (err) { console.error('❌ Erro ao carregar dados:', err.message); }
    finally { setSyncing(false); }
  }, [])

  const saveToSupabase = useCallback(async (userId, newSentLogs, newQueue, newSeason) => {
    if (!userId || !dataLoadedRef.current) return
    try {
      const { error } = await supabase.from('users').update({ sent_logs: newSentLogs, queue_data: newQueue, selected_season: newSeason }).eq('id', userId)
      if (error) console.warn('Erro ao salvar:', error.message)
    } catch (err) { console.warn('❌ Erro ao salvar no Supabase:', err.message); }
  }, [])

  // Detecta o retorno do Google OAuth de forma automática
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get('status')
    if (status === 'sucesso') {
      alert('✅ Gmail conectado com sucesso! Suas candidaturas agora sairão por sua própria conta.')
      window.history.replaceState({}, document.title, window.location.pathname)
      if (user?.id) loadFromSupabase(user.id)
    } else if (status === 'erro') {
      alert('❌ Erro ao integrar com o Gmail do Google. Tente novamente.')
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [user?.id, loadFromSupabase])

  useEffect(() => {
    if (user?.id && user.id !== currentUserIdRef.current) {
      currentUserIdRef.current = user.id
      dataLoadedRef.current = false
      loadFromSupabase(user.id)
    } else if (!user?.id) {
      currentUserIdRef.current = null
      dataLoadedRef.current = false
    }
  }, [user?.id, loadFromSupabase])

  useEffect(() => {
    if (!user?.id || !dataLoadedRef.current) return
    const timer = setTimeout(() => { saveToSupabase(user.id, sentLogs, queue, selectedSeason) }, 2000)
    return () => clearTimeout(timer)
  }, [sentLogs, queue, selectedSeason, user?.id, saveToSupabase])

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && user?.id) {
        loadFromSupabase(user.id)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [user?.id, loadFromSupabase])

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
          loadedJobs.push(...parsed.data.filter(r => r['Case number']).map((r, i) => parseJobFromCsv(r, i, season.id)))
        } catch (e) { console.error(e); }
      }
      setAllJobs(loadedJobs)
      setLoadingJobs(false)
    }
    loadAllSeasons()
  }, [])

  const jobs = useMemo(() => allJobs.filter(j => j.seasonId === selectedSeason), [allJobs, selectedSeason])
  const totalSeasonJobs = jobs.length
  const currentSeason = seasons.find(s => s.id === selectedSeason)
  const isPremium = user?.premium === true && (!user?.premiumExpiresAt && !user?.premium_expires_at || new Date(user?.premiumExpiresAt || user?.premium_expires_at) > new Date())
  const totalSentEver = sentLogs.length
  const todayKey = getLocalDateKey()
  const todaySent = sentLogs.filter(l => getLocalDateKey(l.sentAt) === todayKey).length
  const todayQueued = queue.filter(i => getLocalDateKey(i.createdAt) === todayKey).length
  const todayUsed = todaySent + todayQueued
  const activeLimit = isPremium ? DAILY_LIMIT : DEMO_LIMIT
  const dailyRemaining = Math.max(0, activeLimit - todayUsed)
  const isDemoBlocked = !isPremium && totalSentEver >= DEMO_LIMIT
  const sentIds = useMemo(() => new Set(sentLogs.map(l => l.jobId)), [sentLogs])
  const queuedIds = useMemo(() => new Set(queue.map(i => i.jobId)), [queue])
  const states = useMemo(() => ['Todos', ...new Set(jobs.map(j => j.state).filter(Boolean))], [jobs])
  const categories = useMemo(() => ['Todas', ...new Set(jobs.map(j => j.category).filter(Boolean))], [jobs])
  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const text = `${job.title} ${translateJobTitleToPt(job.title)} ${job.employer} ${job.location} ${job.category}`
      const matchSearch = text.toLowerCase().includes(search.toLowerCase())
      const matchCategory = categoryFilter === 'Todas' || job.category === categoryFilter
      const matchState = stateFilter === 'Todos' || job.state === stateFilter
      return matchSearch && matchCategory && matchState
    })
  }, [jobs, search, categoryFilter, stateFilter])
  const visibleJobs = filteredJobs.slice(0, 160)
  const selectedJob = jobs.find(j => j.id === selectedJobId) || visibleJobs[0] || null
  const sentCount = sentLogs.filter(l => l.seasonId === selectedSeason).length
  const remainingCount = Math.max(0, totalSeasonJobs - sentCount)
  const progress = totalSeasonJobs > 0 ? Math.min(100, Math.round((sentCount / totalSeasonJobs) * 100)) : 0
  const barColor = progressColor(progress)
  const finalBlocked = totalSeasonJobs > 0 && sentCount >= totalSeasonJobs
  const dailyBlocked = isPremium ? todayUsed >= DAILY_LIMIT : isDemoBlocked
  const systemStatus = finalBlocked ? 'Temporada finalizada' : isDemoBlocked ? 'Demo finalizado' : dailyBlocked ? 'Limite diário atingido' : 'Ativo'

  useEffect(() => { setSelectedIds([]); setSelectedJobId(null); setJobMessage(null) }, [selectedSeason])

  useEffect(() => {
    if (!queueRunning || activeSend || finalBlocked || isDemoBlocked) return
    const next = queue.find(i => i.status === 'queued')
    if (!next) { setQueueRunning(false); return }
    const dueAt = Date.now() + randomDelay(fastMode)
    setQueue(prev => prev.map(i => i.id === next.id ? { ...i, status: 'waiting', dueAt } : i))
    setActiveSend({ queueId: next.id, dueAt })
  }, [queueRunning, activeSend, queue, fastMode, finalBlocked, isDemoBlocked])

  useEffect(() => {
    if (!activeSend) return
    const item = queue.find(i => i.id === activeSend.queueId)
    if (!item) { setActiveSend(null); return }
    const remaining = Math.max(0, activeSend.dueAt - Date.now())
    const timer = setTimeout(() => {
      ;(async () => {
        const job = allJobs.find(j => j.id === item.jobId)
        const attachments = []
        if (user?.resume1_path) attachments.push({ url: user.resume1_path, filename: 'curriculo.pdf' })
        if (user?.cover_letter_path) attachments.push({ url: user.cover_letter_path, filename: 'carta_apresentacao.pdf' })
        const licenseKey = getLicenseKey(user)
        try {
          const response = await fetch(`${API_URL}/api/send-candidature`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              candidateName: user?.name,
              candidateEmail: user?.email,
              candidatePhone: user?.phone,
              employerName: job?.employer,
              employerEmail: job?.contact,
              jobTitle: job?.title,
              jobLocation: job?.fullLocation,
              caseNumber: job?.caseNumber,
              messageBody: user?.employer_message || user?.employerMessage,
              attachments,
              licenseKey,
            }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || !data.ok) {
            throw new Error(data.error || `Erro HTTP ${response.status}`)
          }
          const newLog = {
            id: createSentId(), jobId: item.jobId, jobTitle: item.jobTitle,
            employer: item.employer, contact: item.contact,
            seasonId: item.seasonId, sentAt: new Date().toISOString(),
          }
          const newSentLogs = [...sentLogs, newLog]
          const newQueue = queue.filter(i => i.id !== item.id)
          setSentLogs(newSentLogs)
          setQueue(newQueue)
          setJobMessage({ type: 'success', text: `✅ "${item.jobTitle}" enviada com sucesso.` })
          if (user?.id && dataLoadedRef.current) {
            saveToSupabase(user.id, newSentLogs, newQueue, selectedSeason)
          }
        } catch (err) {
          console.error('❌ Falha ao enviar candidatura:', err)
          setQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'queued' } : i))
          setJobMessage({ type: 'error', text: `Falha ao enviar "${item.jobTitle}": ${err.message}` })
        } finally {
          setActiveSend(null)
        }
      })()
    }, remaining)
    return () => clearTimeout(timer)
  }, [activeSend, queue, allJobs, user, saveToSupabase, selectedSeason, sentLogs])

  useEffect(() => {
    if (!activeSend) { setCountdown(0); return }
    const update = () => setCountdown(Math.max(0, Math.ceil((activeSend.dueAt - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [activeSend])

  function requireLogin(t) { if (!logged || !user) { setPage('login'); return } setPage(t) }

  async function uploadFileToStorage(file, folder = 'documents') {
    if (!file) return null
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Arquivo muito grande. Máximo 5MB permitidos.')
      const fileExt = file.name.split('.').pop()
      const fileName = `${folder}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`
      const { data, error } = await supabase.storage.from('documentos').upload(fileName, file, { cacheControl: '3600', upsert: false })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('documentos').getPublicUrl(data.path)
      return publicUrl
    } catch (error) {
      console.error('❌ Erro no upload:', error)
      throw new Error(`Falha ao enviar arquivo: ${error.message}`)
    }
  }

  async function handleRegister(e) {
    e.preventDefault()
    if (!validateRegister()) { setRegisterStatus({ type: 'error', text: 'Preencha os campos em vermelho.' }); return }
    if (!registerForm.resumeFile) { setRegisterStatus({ type: 'error', text: '⚠️ O Currículo Principal é obrigatório!' }); return }
    setUploadingFiles(true)
    setRegisterStatus({ type: 'info', text: '⏳ Enviando seus documentos...' })
    try {
      const [resumeUrl, coverLetterUrl] = await Promise.all([
        registerForm.resumeFile ? uploadFileToStorage(registerForm.resumeFile, 'resumes') : Promise.resolve(null),
        registerForm.coverLetterFile ? uploadFileToStorage(registerForm.coverLetterFile, 'cover_letters') : Promise.resolve(null)
      ])
      const newUser = {
        name: registerForm.name.trim(),
        email: registerForm.email.toLowerCase().trim(),
        password: registerForm.password.trim(),
        phone: registerForm.phone.trim(),
        address: registerForm.address,
        cep: registerForm.cep,
        state: registerForm.state,
        country: registerForm.country || 'Brasil',
        employer_message: registerForm.employerMessage,
        premium: false,
        access_key: `${FREE_ACCESS_KEY}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        resume1_path: resumeUrl,
        resume2_path: null,
        resume3_path: null,
        cover_letter_path: coverLetterUrl,
        sent_logs: [],
        queue_data: [],
        selected_season: 'winter-2025',
      }
      const { data, error } = await supabase.from('users').insert([newUser]).select().single()
      if (error) throw error
      setUser(data)
      setLogged(true)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(data))
      setRegisterStatus({ type: 'success', text: '✅ Cadastro realizado com sucesso! Redirecionando...' })
      setTimeout(() => setPage('dashboard'), 1500)
    } catch (error) {
      console.error('Erro ao criar conta:', error)
      let message = 'Erro ao criar conta. Tente novamente.'
      if (String(error?.message || '').toLowerCase().includes('duplicate')) {
        message = 'Este e-mail já está cadastrado. Faça login ou use outro e-mail.'
      }
      setRegisterStatus({ type: 'error', text: message })
    } finally {
      setUploadingFiles(false)
    }
  }

  async function handleLogin(e) {
    e.preventDefault()
    setLoginError('')
    const email = loginForm.email.trim().toLowerCase()
    const password = loginForm.password.trim()
    if (!email || !password) { setLoginError('Digite seu e-mail e senha.'); return }
    try {
      const { data: userData, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle()
      if (error) throw error
      if (!userData) { setLoginError('E-mail não encontrado.'); return }
      if (String(userData.password || '').trim() !== password) { setLoginError('Senha incorreta.'); return }
      setUser(userData)
      setLogged(true)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(userData))
      setPage('dashboard')
    } catch (err) {
      setLoginError('Erro ao fazer login.')
    }
  }

  async function handleRecover(e) {
    e.preventDefault()
    setRecoveryStatus(null)
    const email = recoveryEmail.trim().toLowerCase()
    if (!email) { setRecoveryStatus({ type: 'error', text: 'Digite seu e-mail.' }); return }
    try {
      const { data: userData, error } = await supabase.from('users').select('email,password').eq('email', email).maybeSingle()
      if (error) throw error
      if (!userData) { setRecoveryStatus({ type: 'error', text: 'E-mail não encontrado.' }); return }
      setRecoveryStatus({ type: 'success', text: `Sua senha: ${userData.password}` })
    } catch (err) {
      setRecoveryStatus({ type: 'error', text: 'Erro ao recuperar senha.' })
    }
  }

  function handleRegisterFile(field, e) {
    const file = e.target.files?.[0]
    if (!file) { setRegisterForm(p => ({ ...p, [`${field}File`]: null, [`${field}FileName`]: '' })); return }
    if (file.size > 5 * 1024 * 1024) { setRegisterStatus({ type: 'error', text: 'Arquivo muito grande. Máximo 5MB.' }); e.target.value = ''; return }
    setRegisterForm(p => ({ ...p, [`${field}File`]: file, [`${field}FileName`]: file.name }))
  }

  function handleProfileFile(field, e) {
    const file = e.target.files?.[0]
    if (file && file.size > 5 * 1024 * 1024) { alert('Arquivo muito grande. Máximo 5MB.'); e.target.value = ''; return }
    if (file) { setProfileForm(p => ({ ...p, [`${field}File`]: file, [`${field}FileName`]: file.name })) }
  }

  function validateRegister() {
    const errors = {}
    if (!registerForm.name.trim()) errors.name = 'Obrigatório.'
    if (!registerForm.email.trim().includes('@')) errors.email = 'E-mail inválido.'
    if (!registerForm.password.trim()) errors.password = 'Obrigatório.'
    if (!registerForm.phone.trim()) errors.phone = 'Obrigatório.'
    setRegisterErrors(errors)
    return Object.keys(errors).length === 0
  }

  function openProfile() {
    if (!user) return
    setProfileForm({
      ...user,
      employerMessage: user.employer_message || '',
      resumeFile: null, coverLetterFile: null,
      resumeFileName: user.resume1_path ? 'Arquivo carregado' : '',
      coverLetterFileName: user.cover_letter_path ? 'Arquivo carregado' : '',
    })
    setActivationStatus(null)
    setActivationKey('')
    setPage('profile')
  }

  function handleAvatarUpload(e) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = () => setProfileForm(p => ({ ...p, avatar: reader.result }))
    reader.readAsDataURL(file)
  }

  // CHAMADA GMAIL API DO GOOGLE
  const handleConnectGmail = async () => {
    if (!user?.email) return alert('Sessão expirada. Faça login novamente.')
    setLoadingGmail(true)
    
    // Força uso dinâmico do Render ou do Localhost
    const activeApiUrl = window.location.hostname.includes('vercel.app')
      ? 'https://future-eua-h2b-api.onrender.com'
      : API_URL;

    try {
      const res = await fetch(`${activeApiUrl}/api/gmail/auth-url?email=${encodeURIComponent(user.email)}`)
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`)
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        alert('Erro ao gerar link do Google: Resposta da API inválida.')
      }
    } catch (err) {
      console.error('Falha na requisição:', err)
      alert('Erro de conexão: Não foi possível alcançar o servidor de autenticação.')
    } finally {
      setLoadingGmail(false)
    }
  }

  async function saveProfile(e) {
    e.preventDefault()
    if (!user?.resume1_path && !profileForm.resumeFile) { alert('⚠️ É necessário ter pelo menos um currículo principal.'); return }
    setUploadingFiles(true)
    try {
      let updates = { phone: profileForm.phone, employer_message: profileForm.employerMessage }
      if (profileForm.resumeFile) {
        const url = await uploadFileToStorage(profileForm.resumeFile, 'resumes')
        if (url) updates.resume1_path = url
      }
      if (profileForm.coverLetterFile) {
        const url = await uploadFileToStorage(profileForm.coverLetterFile, 'cover_letters')
        if (url) updates.cover_letter_path = url
      }
      const { error } = await supabase.from('users').update(updates).eq('id', user.id)
      if (error) throw error
      const updated = { ...user, ...updates, employer_message: profileForm.employerMessage }
      setUser(updated)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(updated))
      alert('✅ Perfil atualizado com sucesso!')
      setPage('dashboard')
    } catch (err) {
      alert(`❌ Erro: ${err.message}`)
    } finally {
      setUploadingFiles(false)
    }
  }

  function handleLogout() {
    setLogged(false)
    setPage('home')
    setUser(null)
    setSentLogs([])
    setQueue([])
    dataLoadedRef.current = false
    currentUserIdRef.current = null
    localStorage.removeItem(USER_SESSION_KEY)
  }

  async function activatePremiumKey() {
    setActivationStatus(null)
    const cleanedKey = activationKey.trim().toUpperCase()
    if (!cleanedKey || cleanedKey.length < 10) { setActivationStatus({ type: 'error', text: 'Digite sua chave Premium completa.' }); return }
    try {
      const response = await fetch(`${API_URL}/api/activate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cleanedKey, user }),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error || 'Chave inválida.')
      const updatedUser = { ...user, ...data.userUpdate }
      await supabase.from('users').update({
        premium: true,
        access_key: cleanedKey,
        premium_expires_at: data.userUpdate.premiumExpiresAt,
      }).eq('id', user.id)
      setUser(updatedUser)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(updatedUser))
      setProfileForm(prev => ({ ...prev, ...updatedUser }))
      setActivationStatus({ type: 'success', text: '✅ Chave Premium ativada!' })
      setActivationKey('')
    } catch {
      setActivationStatus({ type: 'error', text: 'Erro de conexão.' })
    }
  }

  function toggleSelect(jobId) {
    if (isDemoBlocked || finalBlocked) return
    if (sentIds.has(jobId) || queuedIds.has(jobId)) { setJobMessage({ type: 'error', text: 'Vaga já enviada ou na fila.' }); return }
    if (selectedIds.includes(jobId)) { setSelectedIds(p => p.filter(id => id !== jobId)); return }
    if (selectedIds.length >= dailyRemaining) { setJobMessage({ type: 'error', text: `Limite atingido. Restam ${dailyRemaining}.` }); return }
    setSelectedIds(p => [...p, jobId])
  }

  function selectFirstAvailable() {
    if (isDemoBlocked) return
    const avail = visibleJobs.filter(j => !sentIds.has(j.id) && !queuedIds.has(j.id)).slice(0, dailyRemaining)
    setSelectedIds(avail.map(j => j.id))
  }

  function clearSelection() { setSelectedIds([]); setJobMessage(null) }

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
    setJobMessage({ type: 'success', text: `${newItems.length} candidatura(s) adicionada(s) à fila.` })
  }
    // ===================== RENDERIZAÇÃO =====================
  return (
    <div className="app">
      {syncing && (
        <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#1a3a8f', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, zIndex: 9999 }}>
          🔄 Sincronizando...
        </div>
      )}

      {page === 'home' && <Home onRegister={() => setPage('register')} onLogin={() => setPage('login')} />}

      {page === 'login' && (
        <AuthShell>
          <form className="auth-card" onSubmit={handleLogin}>
            <BrandBlock />
            <h2>Fazer login</h2>
            {loginError && <div className="alert error">{loginError}</div>}
            <label>E-mail<input type="email" value={loginForm.email} onChange={e => setLoginForm(p => ({ ...p, email: e.target.value }))} placeholder="seuemail@email.com" /></label>
            <label>Senha<input type="password" value={loginForm.password} onChange={e => setLoginForm(p => ({ ...p, password: e.target.value }))} placeholder="Sua senha" /></label>
            <button className="primary-btn" type="submit">Entrar</button>
            <button className="ghost-btn" type="button" onClick={() => setPage('recover')}>Esqueci minha senha</button>
            <button className="text-btn" type="button" onClick={() => setPage('home')}>Voltar</button>
          </form>
        </AuthShell>
      )}

      {page === 'recover' && (
        <AuthShell>
          <form className="auth-card" onSubmit={handleRecover}>
            <BrandBlock />
            <h2>Recuperar senha</h2>
            {recoveryStatus && <div className={`alert ${recoveryStatus.type}`}>{recoveryStatus.text}</div>}
            <label>E-mail<input type="email" value={recoveryEmail} onChange={e => setRecoveryEmail(e.target.value)} placeholder="seuemail@email.com" /></label>
            <button className="primary-btn" type="submit">Enviar</button>
            <button className="text-btn" type="button" onClick={() => setPage('login')}>Voltar</button>
          </form>
        </AuthShell>
      )}

      {page === 'register' && (
        <AuthShell>
          <form className="auth-card large" onSubmit={handleRegister}>
            <BrandBlock />
            <h2>Cadastro completo</h2>
            {registerStatus && <div className={`alert ${registerStatus.type}`}>{registerStatus.text}</div>}
            {uploadingFiles && <div className="alert info">⏳ Enviando arquivos...</div>}
            <div className="form-section"><h3>Dados pessoais</h3><div className="grid two"><Field label="Nome completo" error={registerErrors.name} value={registerForm.name} onChange={v => setRegisterForm(p => ({ ...p, name: v }))} /><Field label="E-mail" type="email" error={registerErrors.email} value={registerForm.email} onChange={v => setRegisterForm(p => ({ ...p, email: v }))} /><Field label="Senha" type="password" error={registerErrors.password} value={registerForm.password} onChange={v => setRegisterForm(p => ({ ...p, password: v }))} /><Field label="Telefone" error={registerErrors.phone} value={registerForm.phone} onChange={v => setRegisterForm(p => ({ ...p, phone: v }))} /></div></div>
            <div className="form-section"><h3>Endereço</h3><div className="grid two"><Field label="Endereço" value={registerForm.address} onChange={v => setRegisterForm(p => ({ ...p, address: v }))} /><Field label="CEP" value={registerForm.cep} onChange={v => setRegisterForm(p => ({ ...p, cep: v }))} /><Field label="Estado" value={registerForm.state} onChange={v => setRegisterForm(p => ({ ...p, state: v }))} /><Field label="País" value={registerForm.country} onChange={v => setRegisterForm(p => ({ ...p, country: v }))} /></div></div>
            <div className="form-section"><h3>Documentos</h3><div className="grid two"><label>Currículo Principal *<input type="file" accept=".pdf,.doc,.docx" onChange={e => handleRegisterFile('resume', e)} disabled={uploadingFiles} required />{registerForm.resumeFileName && <small>✅ {registerForm.resumeFileName}</small>}</label><label>Carta de Apresentação (Opcional)<input type="file" accept=".pdf,.doc,.docx" onChange={e => handleRegisterFile('coverLetter', e)} disabled={uploadingFiles} />{registerForm.coverLetterFileName && <small>✅ {registerForm.coverLetterFileName}</small>}</label></div></div>
            <div className="form-section"><h3>Mensagem padrão para empregador</h3><label><textarea rows="5" value={registerForm.employerMessage} onChange={e => setRegisterForm(p => ({ ...p, employerMessage: e.target.value }))} /></label></div>
            <button className="primary-btn" type="submit" disabled={uploadingFiles}>{uploadingFiles ? '⏳ Enviando...' : 'Concluir cadastro'}</button>
            <button className="text-btn" type="button" onClick={() => setPage('home')} disabled={uploadingFiles}>Voltar</button>
          </form>
        </AuthShell>
      )}

      {page === 'dashboard' && (
        <Dashboard
          user={user} currentSeason={currentSeason} selectedSeason={selectedSeason}
          setSelectedSeason={setSelectedSeason} sentCount={sentCount} remainingCount={remainingCount}
          progress={progress} barColor={barColor} todaySent={todaySent} averageDaily={todaySent}
          systemStatus={systemStatus} finalBlocked={finalBlocked} dailyBlocked={dailyBlocked}
          todayQueued={todayQueued} dailyRemaining={dailyRemaining} queueLength={queue.length}
          activeSend={activeSend} countdown={countdown} onJobs={() => requireLogin('jobs')}
          onProfile={openProfile} onLogout={handleLogout} totalSeasonJobs={totalSeasonJobs}
          loadingJobs={loadingJobs} isPremium={isPremium} totalSentEver={totalSentEver}
          isDemoBlocked={isDemoBlocked} gmailConnected={gmailConnected} gmailEmail={gmailEmail}
          handleConnectGmail={handleConnectGmail} loadingGmail={loadingGmail}
        />
      )}

      {page === 'jobs' && (
        <JobsPage
          user={user} currentSeason={currentSeason} selectedSeason={selectedSeason}
          setSelectedSeason={setSelectedSeason} visibleJobs={visibleJobs} filteredJobs={filteredJobs}
          selectedJob={selectedJob} setSelectedJobId={setSelectedJobId} selectedIds={selectedIds}
          toggleSelect={toggleSelect} selectFirstAvailable={selectFirstAvailable}
          clearSelection={clearSelection} sendSelected={sendSelected} sentIds={sentIds}
          queuedIds={queuedIds} search={search} setSearch={setSearch} categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter} stateFilter={stateFilter} setStateFilter={setStateFilter}
          states={states} categories={categories} finalBlocked={finalBlocked} dailyBlocked={dailyBlocked}
          dailyRemaining={dailyRemaining} todaySent={todaySent} todayQueued={todayQueued}
          jobMessage={jobMessage} queueRunning={queueRunning} setQueueRunning={setQueueRunning}
          activeSend={activeSend} countdown={countdown} fastMode={fastMode} setFastMode={setFastMode}
          onDashboard={() => setPage('dashboard')} onProfile={openProfile} loadingJobs={loadingJobs}
          isDemoBlocked={isDemoBlocked} totalSentEver={totalSentEver} isPremium={isPremium}
        />
      )}

      {page === 'profile' && profileForm && (
        <AuthShell>
          <form className="auth-card large" onSubmit={saveProfile}>
            <BrandBlock />
            <h2>Editar perfil</h2>
            {uploadingFiles && <div className="alert info">⏳ Enviando documentos...</div>}
            {isPremium && <div className="alert success">✅ <strong>Conta Premium Ativa.</strong> Dados bloqueados.</div>}
            <div className="profile-edit-head"><Avatar user={profileForm} size="big" /><label className="upload-avatar">Trocar foto<input type="file" accept="image/*" onChange={handleAvatarUpload} /></label></div>
            <div className="form-section"><h3>Dados pessoais (Bloqueados)</h3><div className="grid two"><Field label="Nome completo" value={profileForm.name || ''} disabled={true} onChange={() => {}} /><Field label="E-mail" value={profileForm.email || ''} disabled={true} onChange={() => {}} /><Field label="Telefone" value={profileForm.phone || ''} onChange={v => setProfileForm(p => ({ ...p, phone: v }))} /><Field label="Endereço" value={profileForm.address || ''} disabled={true} onChange={() => {}} /><Field label="CEP" value={profileForm.cep || ''} disabled={true} onChange={() => {}} /><Field label="Estado" value={profileForm.state || ''} disabled={true} onChange={() => {}} /><Field label="País" value={profileForm.country || ''} disabled={true} onChange={() => {}} /></div></div>
            <div className="form-section"><h3>Documentos</h3><div className="grid two"><label>Currículo Principal<input type="file" accept=".pdf,.doc,.docx" onChange={e => handleProfileFile('resume', e)} disabled={uploadingFiles} />{profileForm.resumeFileName && <small>✅ {profileForm.resumeFileName}</small>}{user?.resume1_path && <small style={{color: '#666'}}>🔗 <a href={user.resume1_path} target="_blank" rel="noreferrer">Ver atual</a></small>}</label><label>Carta de Apresentação<input type="file" accept=".pdf,.doc,.docx" onChange={e => handleProfileFile('coverLetter', e)} disabled={uploadingFiles} />{profileForm.coverLetterFileName && <small>✅ {profileForm.coverLetterFileName}</small>}{user?.cover_letter_path && <small style={{color: '#666'}}>🔗 <a href={user.cover_letter_path} target="_blank" rel="noreferrer">Ver atual</a></small>}</label></div></div>
            <div className="form-section"><h3>Mensagem padrão para empregador</h3><label><textarea rows="6" value={profileForm.employerMessage || ''} onChange={e => setProfileForm(p => ({ ...p, employerMessage: e.target.value }))} /></label></div>

            {/* 📧 BLOCO GMAIL INTEGRADO NA EDICÃO DE PERFIL */}
            <div className="form-section gmail-integration-box" style={{ background: 'rgba(26, 58, 143, 0.1)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(26, 58, 143, 0.3)', marginTop: '20px' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>📧 Conexão Gmail</h3>
              <p style={{ fontSize: '13px', opacity: 0.8, marginBottom: '15px', lineHeight: '1.4' }}>
                Conecte seu Gmail para enviar candidaturas pelo seu próprio e-mail e receber as respostas automáticas dos empregadores (férias, vaga encerrada) na sua caixa de entrada.
              </p>
              
              {gmailConnected ? (
                <div style={{ background: 'rgba(22, 163, 74, 0.1)', border: '1px solid #16a34a', padding: '12px', borderRadius: '8px' }}>
                  <p style={{ color: '#4ade80', fontSize: '14px', fontWeight: 'bold' }}>✅ Gmail Conectado</p>
                  <p style={{ fontSize: '12px', opacity: 0.7, marginTop: '4px' }}>Conta: {gmailEmail || user?.email}</p>
                </div>
              ) : (
                <button 
                  type="button" 
                  className="primary-btn" 
                  style={{ width: '100%', background: '#fff', color: '#000' }}
                  onClick={handleConnectGmail}
                  disabled={loadingGmail}
                >
                  {loadingGmail ? '⏳ Carregando...' : '🔗 Conectar meu Gmail'}
                </button>
              )}
            </div>

            {!isPremium && (
              <div className="form-section premium-activation-box">
                <h3>🔑 Ativar Chave Premium</h3>
                {activationStatus && <div className={`alert ${activationStatus.type}`}>{activationStatus.text}</div>}
                <input className="premium-key-input" value={activationKey} maxLength={19} placeholder="XXXX-XXXX-XXXX-XXXX" onChange={e => setActivationKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})/g, '$1-').replace(/-$/, '').slice(0, 19))} />
                <button type="button" className="primary-btn" style={{ marginTop: 12, width: '100%' }} onClick={activatePremiumKey}>Ativar Premium</button>
                <p style={{ marginTop: 10, fontSize: 13, opacity: 0.7, textAlign: 'center' }}>Não tem uma chave? <a href={CONTACT_LINK} target="_blank" rel="noreferrer" style={{ color: '#facc15' }}>Clique aqui para comprar</a></p>
              </div>
            )}
            <button className="primary-btn" type="submit" style={{ marginTop: 16 }} disabled={uploadingFiles}>{uploadingFiles ? '⏳ Salvando...' : 'Salvar perfil'}</button>
            <button className="ghost-btn" type="button" onClick={() => setPage('dashboard')} disabled={uploadingFiles}>Voltar</button>
          </form>
        </AuthShell>
      )}

      {page !== 'home' && <GlobalFooter />}
    </div>
  )
}

// ===================== COMPONENTES VISUAIS (TopBar, Avatar, etc) =====================

function Home({ onRegister, onLogin }) {
  return (
    <main className="home home-premium">
      <div className="home-overlay" />
      <section className="home-stage">
        <div className="home-brand-side"><div className="home-brand-big"><div className="home-brand-logo"><RotatingLogo /></div><div className="home-brand-text"><h1>FUTURE EUA H2B</h1><p>Rumo ao sonho americano</p></div></div></div>
        <div className="home-hero-card"><span className="pill">Brasil → Estados Unidos</span><h2>Organize suas candidaturas H2B em um painel moderno</h2><p>Sistema para cadastro, dashboard de temporada, controle de limite diário e organização de vagas sazonais.</p><div className="home-actions premium-home-actions"><button className="primary-btn" onClick={onRegister}>Cadastrar-se</button><button className="ghost-light-btn" onClick={onLogin}>Fazer login</button></div></div>
      </section>
    </main>
  )
}

function AuthShell({ children }) { return <main className="auth-shell"><div className="auth-bg" />{children}</main> }
function BrandBlock() { return <div className="brand-block"><RotatingLogo /><div><h1>FUTURE EUA H2B</h1><p>Rumo ao sonho americano</p></div></div> }
function RotatingLogo() { return <div className="rotating-logo logo-image"><img src="/logo-br-us.png" alt="Future EUA H2B" /></div> }

function Field({ label, value, onChange, type = 'text', error, disabled }) {
  return (
    <label className={`${error ? 'has-error' : ''} ${disabled ? 'field-disabled' : ''}`}>
      {label}
      <input type={type} value={value || ''} disabled={disabled} onChange={e => { if (!disabled) onChange(e.target.value) }} />
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

function Dashboard({ user, currentSeason, selectedSeason, setSelectedSeason, sentCount, remainingCount, progress, barColor, todaySent, averageDaily, systemStatus, finalBlocked, dailyBlocked, todayQueued, dailyRemaining, queueLength, activeSend, countdown, onJobs, onProfile, onLogout, totalSeasonJobs, loadingJobs, isPremium, totalSentEver, isDemoBlocked, gmailConnected, gmailEmail, handleConnectGmail, loadingGmail }) {
  return (
    <main className="dashboard-page">
      <TopBar user={user} onDashboard={() => {}} onJobs={onJobs} onProfile={onProfile} onLogout={onLogout} finalBlocked={finalBlocked} />
      <section className="container">
        <div className="dashboard-hero"><div><span className="pill">Painel principal</span><h2>Dashboard da temporada</h2><p>Acompanhe progresso geral e status do sistema.</p></div><div className="season-box"><label>Temporada</label><select value={selectedSeason} onChange={e => setSelectedSeason(e.target.value)}>{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div></div>
        <div className="key-card"><div><strong>{isPremium ? '✅ Conta Premium Ativa' : '🔑 Acesso Demonstração'}</strong><p>Chave: <span>{user?.access_key || FREE_ACCESS_KEY}</span></p>{!isPremium && <p style={{ color: '#fbbf24', marginTop: 6 }}>Envios de teste: <strong>{totalSentEver}</strong> / {DEMO_LIMIT}</p>}</div><div className="price-tag">{isPremium ? '🚀 Premium Ativo' : 'R$200/temporada'}</div></div>
        
        {/* 📧 BLOCO DO GMAIL NO DASHBOARD */}
        <section className="panel" style={{ marginTop: '20px', border: '1px solid rgba(26, 58, 143, 0.3)', background: 'rgba(26, 58, 143, 0.05)' }}>
          <div className="panel-head">
            <div>
              <h3>📧 Conexão Gmail</h3>
              <p>Para receber respostas automáticas dos empregadores</p>
            </div>
            <span style={{ 
              padding: '4px 10px', 
              borderRadius: '20px', 
              fontSize: '11px', 
              fontWeight: 'bold',
              background: gmailConnected ? 'rgba(22, 163, 74, 0.2)' : 'rgba(239, 68, 68, 0.2)',
              color: gmailConnected ? '#4ade80' : '#f87171'
            }}>
              {gmailConnected ? 'CONECTADO' : 'DESCONECTADO'}
            </span>
          </div>

          <div style={{ padding: '15px 0' }}>
            {gmailConnected ? (
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p style={{ fontSize: '13px', color: '#ccc' }}>✅ Seu sistema está enviando pelo e-mail:</p>
                <p style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '5px', color: '#4ade80' }}>{gmailEmail || user?.email}</p>
              </div>
            ) : (
              <button 
                type="button"
                className="primary-btn" 
                style={{ width: '100%', background: '#fff', color: '#000' }}
                onClick={handleConnectGmail}
                disabled={loadingGmail}
              >
                {loadingGmail ? '⏳ Redirecionando...' : '🔗 Conectar meu Gmail agora'}
              </button>
            )}
          </div>
        </section>

        {loadingJobs && <div className="alert warning">Carregando vagas...</div>}
        {finalBlocked && <div className="alert error">Temporada finalizada.</div>}
        {!isPremium && totalSentEver >= DEMO_LIMIT && (<div className="alert error demo-lock-box"><p>🚀 <strong>Período de teste finalizado</strong></p><p>Você utilizou {totalSentEver}/{DEMO_LIMIT} envios gratuitos.</p><a href={CONTACT_LINK} target="_blank" rel="noreferrer" className="buy-key-btn">Comprar Chave Premium</a></div>)}
        <div className="stats-grid"><StatCard title="Total da temporada" value={`${totalSeasonJobs} vagas`} /><StatCard title="Enviadas" value={sentCount} /><StatCard title="Restantes" value={remainingCount} /><StatCard title="Status" value={systemStatus} /></div>
        <section className="panel"><div className="panel-head"><div><h3>Progresso geral</h3><p>{currentSeason?.label}</p></div><strong>{progress}%</strong></div><div className="life-bar"><div className={`life-fill ${barColor}`} style={{ width: `${progress}%` }} /></div></section>
        <div className="stats-grid"><StatCard title="Hoje" value={`${todaySent} enviadas`} /><StatCard title="Na fila hoje" value={todayQueued} /><StatCard title="Média diária" value={averageDaily} /><StatCard title="Restante hoje" value={dailyRemaining} /></div>
        <section className="panel"><h3>Status da fila</h3><div className="queue-info"><div><strong>{queueLength}</strong><span>itens na fila</span></div><div><strong>{dailyRemaining}</strong><span>envios restantes</span></div><div><strong>{activeSend ? formatSeconds(countdown) : '—'}</strong><span>próximo envio</span></div></div></section>
        <div className="actions-row">{!finalBlocked && !isDemoBlocked && (<button className="primary-btn" onClick={onJobs}>Abrir painel de vagas</button>)}{isDemoBlocked && (<button className="primary-btn" onClick={onJobs}>Ver vagas</button>)}<button className="ghost-btn" onClick={onProfile}>Editar perfil</button><button className="logout-btn" onClick={onLogout}>Sair</button></div>
      </section>
    </main>
  )
}

function JobsPage({ user, currentSeason, selectedSeason, setSelectedSeason, visibleJobs, filteredJobs, selectedJob, setSelectedJobId, selectedIds, toggleSelect, selectFirstAvailable, clearSelection, sendSelected, sentIds, queuedIds, search, setSearch, categoryFilter, setCategoryFilter, stateFilter, setStateFilter, states, categories, finalBlocked, dailyBlocked, dailyRemaining, todaySent, todayQueued, jobMessage, queueRunning, setQueueRunning, activeSend, countdown, fastMode, setFastMode, onDashboard, onProfile, loadingJobs, isDemoBlocked, totalSentEver, isPremium }) {
  const sendHidden = finalBlocked || dailyBlocked
  return (
    <main className="jobs-page">
      <TopBar user={user} onDashboard={onDashboard} onJobs={() => {}} onProfile={onProfile} onLogout={() => {}} finalBlocked={finalBlocked} hideLogout />
      <section className="container">
        <div className="dashboard-hero jobs-hero-custom"><div><span className="pill">Painel de vagas</span><h2>Painel de vagas</h2><p>{isPremium ? `Limite diário: 100 vagas. Restantes hoje: ${dailyRemaining}` : `Modo demonstração: ${totalSentEver}/${DEMO_LIMIT} envios usados.`}</p></div><div className="season-box"><label>Temporada</label><select value={selectedSeason} onChange={e => setSelectedSeason(e.target.value)}>{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div></div>
        <div className="mini-status"><span>Temporada: {currentSeason?.label}</span><span>Hoje: {todaySent} enviados</span><span>Fila hoje: {todayQueued}</span><span>Restante hoje: {dailyRemaining}</span></div>
        {loadingJobs && <div className="alert warning">Carregando vagas...</div>}
        {jobMessage && <div className={`alert ${jobMessage.type}`}>{jobMessage.text}</div>}
        {isDemoBlocked && (<div className="alert error demo-lock-box"><p>🚀 <strong>Período de teste finalizado</strong></p><p>Você utilizou {totalSentEver}/{DEMO_LIMIT} envios gratuitos.</p><a href={CONTACT_LINK} target="_blank" rel="noreferrer" className="buy-key-btn">Comprar Chave Premium</a></div>)}
        {!isDemoBlocked && sendHidden && (<div className="alert error">{finalBlocked ? 'Temporada finalizada.' : 'Limite diário atingido.'}</div>)}
        <div className="jobs-top-filters"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔎 Pesquisar vaga..." /><select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select><select value={stateFilter} onChange={e => setStateFilter(e.target.value)}>{states.map(s => <option key={s}>{s}</option>)}</select></div>
        <div className="jobs-total-line">{!loadingJobs && <span>{filteredJobs.length} vaga(s) no filtro.</span>}</div>
        <div className="jobs-selection-summary"><div><strong>{selectedIds.length} vaga(s) selecionada(s)</strong></div><div className="jobs-selection-actions"><button className="ghost-btn" onClick={selectFirstAvailable} disabled={sendHidden || loadingJobs || isDemoBlocked}>Selecionar disponíveis</button><button className="ghost-btn" onClick={clearSelection}>Limpar</button><button className={`primary-btn ${isDemoBlocked || sendHidden ? 'disabled-off' : ''}`} onClick={sendSelected} disabled={selectedIds.length === 0 || loadingJobs || sendHidden || isDemoBlocked}>{isDemoBlocked ? 'Teste finalizado' : `Enviar (${selectedIds.length})`}</button></div></div>
        <div className="jobs-queue-bar"><label className="check-row"><input type="checkbox" checked={queueRunning} onChange={e => setQueueRunning(e.target.checked)} /> Processar fila</label><label className="check-row"><input type="checkbox" checked={fastMode} onChange={e => setFastMode(e.target.checked)} /> Modo teste rápido</label><span className="queue-next-send">Próximo envio: <strong>{activeSend ? formatSeconds(countdown) : 'aguardando'}</strong></span></div>
        <div className="jobs-two-columns">
          <section className="jobs-list-panel"><div className="jobs-panel-head"><h3>LISTA DE VAGAS</h3><p>{loadingJobs ? 'Carregando...' : `Mostrando ${visibleJobs.length} de ${filteredJobs.length}`}</p></div><div className="jobs-list-scroll">{!loadingJobs && visibleJobs.map(job => { const alreadySent = sentIds.has(job.id); const alreadyQueued = queuedIds.has(job.id); const selected = selectedIds.includes(job.id); return (<div key={job.id} className={`job-master-item ${selectedJob?.id === job.id ? 'active' : ''}`}><button type="button" className={`job-select-dot ${selected ? 'checked' : ''} ${alreadySent ? 'sent' : ''} ${alreadyQueued ? 'queued' : ''}`} disabled={sendHidden || alreadySent || alreadyQueued || isDemoBlocked} onClick={e => { e.stopPropagation(); toggleSelect(job.id) }}><span /></button><button type="button" className="job-master-main" onClick={() => setSelectedJobId(job.id)}><div className="job-master-title-line"><strong>{translateJobTitleToPt(job.title)}</strong><span className="job-master-location">— {job.location}</span></div><div className="job-master-subline"><span>{job.employer}</span>{alreadySent && <span className="job-status-pill sent">Enviado</span>}{alreadyQueued && <span className="job-status-pill queued">Na fila</span>}</div></button><div className="job-master-right"><strong>{job.wage}</strong></div></div>) })}{!loadingJobs && visibleJobs.length === 0 && <div className="empty-box">Nenhuma vaga encontrada.</div>}</div></section>
          <section className="jobs-detail-panel"><div className="jobs-panel-head"><h3>DETALHE DA VAGA</h3><p>{selectedJob ? selectedJob.category : 'Selecione uma vaga'}</p></div><div className="jobs-detail-scroll">{selectedJob ? (<div className="detail-card detail-card-pt"><h2>{translateJobTitleToPt(selectedJob.title)}</h2><p className="detail-employer">{selectedJob.employer}</p><InfoLine label="Local" value={selectedJob.fullLocation} /><InfoLine label="Cidade / Estado" value={`${selectedJob.city} / ${selectedJob.state}`} /><InfoLine label="Vagas" value={`${selectedJob.available}`} /><InfoLine label="Início" value={selectedJob.startDate} /><InfoLine label="Fim" value={selectedJob.endDate} /><InfoLine label="Salário" value={selectedJob.wageDetail} /><InfoLine label="Telefone" value={selectedJob.phone || 'Não informado'} /><InfoLine label="E-mail empregador" value={selectedJob.contact} /><InfoLine label="Case Number" value={selectedJob.caseNumber} /><InfoLine label="Tipo do visto" value={selectedJob.visaType} /><div className="description-box"><strong>Descrição da vaga</strong><p>{buildPortugueseJobDescription(selectedJob)}</p></div><div className="message-preview"><strong>Mensagem padrão do candidato</strong><p>{user?.employer_message || user?.employerMessage}</p></div></div>) : (<div className="empty-box">Selecione uma vaga para ver os detalhes.</div>)}</div></section>
        </div>
      </section>
    </main>
  )
}

function TopBar({ user, onDashboard, onJobs, onProfile, onLogout, finalBlocked, hideLogout }) {
  return (
    <header className="topbar">
      <div className="topbar-brand"><RotatingLogo /><div><strong>FUTURE EUA H2B</strong><span>Rumo ao sonho americano</span></div></div>
      <nav><button onClick={onDashboard}>Dashboard</button>{!finalBlocked && <button onClick={onJobs}>Vagas</button>}<button onClick={onProfile}>Editar perfil</button></nav>
      <div className="user-box"><Avatar user={user} /><div><strong>{user?.name}</strong><span>{user?.email}</span></div>{!hideLogout && <button className="logout-btn" onClick={onLogout}>Sair</button>}</div>
    </header>
  )
}

function Avatar({ user, size = '' }) {
  if (user?.avatar) return <img className={`avatar ${size}`} src={user.avatar} alt={user.name} />
  return <div className={`avatar initials ${size}`}>{getInitials(user?.name)}</div>
}

function StatCard({ title, value }) { return <div className="stat-card"><span>{title}</span><strong>{value}</strong></div> }
function InfoLine({ label, value }) { return <div className="info-line"><span>{label}</span><strong>{value}</strong></div> }

function GlobalFooter() {
  return (
    <footer className="global-footer">
      <p>⚠️ A plataforma não garante vaga, não garante visto, não garante contratação e não possui vínculo direto com empregadores.</p>
      <p>Este sistema apenas organiza e controla candidaturas. Dados devem ser conferidos em fontes oficiais.</p>
      <p>Crédito de dados: <strong>seasonaljobs.dol.gov</strong> — dados públicos de emprego sazonal.</p>
      <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.1)', margin: '20px auto', maxWidth: '600px' }} />
      <div style={{ marginTop: '16px', textAlign: 'center' }}>
        <p style={{ fontWeight: 'bold', fontSize: '15px', color: '#facc15', marginBottom: '8px' }}>© {new Date().getFullYear()} Bymagno_rust — Todos os direitos reservados</p>
        <p style={{ fontSize: '13px', opacity: 0.85, marginBottom: '6px' }}>📧 Contato: <a href="mailto:magno.elen2023@gmail.com" style={{ color: '#60a5fa', textDecoration: 'none' }}>magno.elen2023@gmail.com</a></p>
        <p style={{ fontSize: '13px', opacity: 0.85 }}>
          <a href="https://wa.me/5575999866105?text=Olá!%20Tenho%20interesse%20no%20FUTURE%20EUA%20H2B" target="_blank" rel="noreferrer" style={{ color: '#25D366', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: '600' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#25D366"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
            +55 (75) 99986-6105
          </a>
        </p>
      </div>
    </footer>
  )
}