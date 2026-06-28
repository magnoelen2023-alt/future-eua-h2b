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

// 🔑 NOVA FUNÇÃO: Extrair LicenseKey de várias possíveis chaves no objeto user
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

  // 🔑 CONTROLE PARA EVITAR SOBRESCREVER DADOS DURANTE CARREGAMENTO
  const dataLoadedRef = useRef(false)
  const currentUserIdRef = useRef(null)

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

  // ===================== SYNC COM SUPABASE - VERSÃO CORRIGIDA =====================
  const loadFromSupabase = useCallback(async (userId) => {
    if (!userId) return
    console.log('🔄 Carregando dados do usuário', userId)
    setSyncing(true)
    dataLoadedRef.current = false
    try {
      const { data, error } = await supabase.from('users').select('*').eq('id', userId).single()
      if (error) throw error
      if (data) {
        console.log('✅ Dados recebidos:', { sent_logs: data.sent_logs?.length || 0, queue_data: data.queue_data?.length || 0, season: data.selected_season })
        setUser(data)
        localStorage.setItem(USER_SESSION_KEY, JSON.stringify(data))
        setSentLogs(Array.isArray(data.sent_logs) ? data.sent_logs : [])
        setQueue(Array.isArray(data.queue_data) ? data.queue_data : [])
        setSelectedSeason(data.selected_season || 'winter-2025')
        setTimeout(() => { dataLoadedRef.current = true; console.log('✅ Sincronização liberada'); }, 500)
      }
    } catch (err) { console.error('❌ Erro ao carregar dados:', err.message); }
    finally { setSyncing(false); }
  }, [])

  const saveToSupabase = useCallback(async (userId, newSentLogs, newQueue, newSeason) => {
    if (!userId || !dataLoadedRef.current) return
    try {
      console.log('💾 Salvando:', { sent: newSentLogs.length, queue: newQueue.length })
      const { error } = await supabase.from('users').update({ sent_logs: newSentLogs, queue_data: newQueue, selected_season: newSeason }).eq('id', userId)
      if (error) console.warn('Erro ao salvar:', error.message)
    } catch (err) { console.warn('❌ Erro ao salvar no Supabase:', err.message); }
  }, [])

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
        console.log('👁️ Aba ativa, recarregando dados...'); loadFromSupabase(user.id)
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

  // 🔑 EFEITO DE ENVIO CORRIDO E ATUALIZADO
  useEffect(() => {
    if (!activeSend) return

    const item = queue.find(i => i.id === activeSend.queueId)
    if (!item) {
      setActiveSend(null)
      return
    }

    const remaining = Math.max(0, activeSend.dueAt - Date.now())

    const timer = setTimeout(() => {
      ;(async () => {
        const job = allJobs.find(j => j.id === item.jobId)
        const attachments = []
        if (user?.resume1_path) attachments.push({ url: user.resume1_path, filename: 'curriculo.pdf' })
        if (user?.cover_letter_path) attachments.push({ url: user.cover_letter_path, filename: 'carta_apresentacao.pdf' })

        // ✅ Pega a chave da licença corretamente
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
              licenseKey, // ✅ ENVIADO AQUI
            }),
          })

          const data = await response.json().catch(() => ({}))

          if (!response.ok || !data.ok) {
            throw new Error(data.error || `Erro HTTP ${response.status}`)
          }

          // Sucesso: Cria log atualiza estado
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
          
          // Devolve a vaga para a fila (status: queued) para tentar novamente
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

  // ===================== LÓGICA DE NEGÓCIO =====================
  function requireLogin(t) { if (!logged || !user) { setPage('login'); return } setPage(t) }

  async function uploadFileToStorage(file, folder = 'documents') {
    if (!file) return null
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Arquivo muito grande.')
      const fileExt = file.name.split('.').pop()
      const fileName = `${folder}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`
      const { data, error } = await supabase.storage.from('documentos').upload(fileName, file, { cacheControl: '3600', upsert: false })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('documentos').getPublicUrl(data.path)
      return publicUrl
    } catch (error) { console.error('❌ Erro no upload:', error); throw new Error(`Falha ao enviar arquivo: ${error.message}`) }
  }

  async function handleRegister(e) {
    e.preventDefault()
    if (!validateRegister()) { setRegisterStatus({ type: 'error', text: 'Preencha os campos.' }); return }
    if (!registerForm.resumeFile) { setRegisterStatus({ type: 'error', text: 'Currículo obrigatório!' }); return }
    setUploadingFiles(true)
    setRegisterStatus({ type: 'info', text: 'Enviando documentos...' })
    try {
      const [resumeUrl, coverLetterUrl] = await Promise.all([
        registerForm.resumeFile ? uploadFileToStorage(registerForm.resumeFile, 'resumes') : Promise.resolve(null),
        registerForm.coverLetterFile ? uploadFileToStorage(registerForm.coverLetterFile, 'cover_letters') : Promise.resolve(null)
      ])
      const newUser = {
        name: registerForm.name.trim(), email: registerForm.email.toLowerCase().trim(), password: registerForm.password.trim(),
        phone: registerForm.phone.trim(), address: registerForm.address, cep: registerForm.cep, state: registerForm.state, country: registerForm.country || 'Brasil',
        employer_message: registerForm.employerMessage, premium: false,
        access_key: `${FREE_ACCESS_KEY}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        resume1_path: resumeUrl, resume2_path: null, resume3_path: null, cover_letter_path: coverLetterUrl,
        sent_logs: [], queue_data: [], selected_season: 'winter-2025',
      }
      const { data, error } = await supabase.from('users').insert([newUser]).select().single()
      if (error) throw error
      setUser(data)
      setLogged(true)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(data))
      setRegisterStatus({ type: 'success', text: 'Cadastro realizado! Redirecionando...' })
      setTimeout(() => setPage('dashboard'), 1500)
    } catch (error) {
      let message = 'Erro ao criar conta.'
      if (String(error?.message || '').toLowerCase().includes('duplicate')) message = 'Este e-mail já está cadastrado.'
      setRegisterStatus({ type: 'error', text: message })
    } finally { setUploadingFiles(false) }
  }

  async function handleLogin(e) {
    e.preventDefault()
    setLoginError('')
    const email = loginForm.email.trim().toLowerCase()
    const password = loginForm.password.trim()
    if (!email || !password) { setLoginError('Digite e-mail e senha.'); return }
    try {
      const { data: userData, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle()
      if (error) throw error
      if (!userData) { setLoginError('E-mail não encontrado.'); return }
      if (String(userData.password || '').trim() !== password) { setLoginError('Senha incorreta.'); return }
      setUser(userData)
      setLogged(true)
      localStorage.setItem(USER_SESSION_KEY, JSON.stringify(userData))
      setPage('dashboard')
    } catch (err) { setLoginError('Erro ao fazer login.'); }
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
    } catch (err) { setRecoveryStatus({ type: 'error', text: 'Erro ao recuperar senha.' }); }
  }

  function handleRegisterFile(field, e) {
    const file = e.target.files?.[0]
    if (!file) { setRegisterForm(p => ({ ...p, [`${field}File`]: null, [`${field}FileName`]: '' })); return }
    if (file.size > 5 * 1024 * 1024) { setRegisterStatus({ type: 'error', text: 'Arquivo muito grande.' }); e.target.value = ''; return }
    setRegisterForm(p => ({ ...p, [`${field}File`]: file, [`${field}FileName`]: file.name }))
  }

  function handleProfileFile(field, e) {
    const file = e.target.files?.[0]
    if (file && file.size > 5 * 1024 * 1024) { alert('Arquivo muito grande.'); e.target.value = ''; return }
    if (file) { setProfileForm(p => ({ ...p, [`${field}File`]: file, [`${field}FileName`]: file.name })) }
  }

  function validateRegister() {
    const errors = {}
    if (!registerForm.name.trim()) errors.name = 'Obrigatório.'
    if (!registerForm.email.trim().includes('@')) errors.email = 'Inválido.'
    if (!registerForm.password.trim()) errors.password = 'Obrigatório.'
    if (!registerForm.phone.trim()) errors.phone = 'Obrigatório.'
    setRegisterErrors(errors)
    return Object.keys(errors).length === 0
  }

  function openProfile() {
    if (!user) return
    setProfileForm({ ...user, employerMessage: user.employer_message || '', resumeFile: null, coverLetterFile: null, resumeFileName: user.resume1_path ? 'Carregado' : '', coverLetterFileName: user.cover_letter_path ? 'Carregado' : '' })
    setActivationStatus(null); setActivationKey(''); setPage('profile')
  }

  function handleAvatarUpload(e) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader(); reader.onload = () => setProfileForm(p => ({ ...p, avatar: reader.result })); reader.readAsDataURL(file)
  }

  async function saveProfile(e) {
    e.preventDefault()
    if (!user?.resume1_path && !profileForm.resumeFile) { alert('Currículo principal necessário.'); return }
    setUploadingFiles(true)
    try {
      let updates = { phone: profileForm.phone, employer_message: profileForm.employerMessage }
      if (profileForm.resumeFile) { const url = await uploadFileToStorage(profileForm.resumeFile, 'resumes'); if (url) updates.resume1_path = url }
      if (profileForm.coverLetterFile) { const url = await uploadFileToStorage(profileForm.coverLetterFile, 'cover_letters'); if (url) updates.cover_letter_path = url }
      const { error } = await supabase.from('users').update(updates).eq('id', user.id)
      if (error) throw error
      const updated = { ...user, ...updates, employer_message: profileForm.employerMessage }
      setUser(updated); localStorage.setItem(USER_SESSION_KEY, JSON.stringify(updated))
      alert('Perfil atualizado!'); setPage('dashboard')
    } catch (err) { alert(`Erro: ${err.message}`) }
    finally { setUploadingFiles(false) }
  }

  function handleLogout() {
    setLogged(false); setPage('home'); setUser(null); setSentLogs([]); setQueue([]);
    dataLoadedRef.current = false; currentUserIdRef.current = null; localStorage.removeItem(USER_SESSION_KEY)
  }

  async function activatePremiumKey() {
    setActivationStatus(null)
    const cleanedKey = activationKey.trim().toUpperCase()
    if (!cleanedKey || cleanedKey.length < 10) { setActivationStatus({ type: 'error', text: 'Chave inválida.' }); return }
    try {
      const response = await fetch(`${API_URL}/api/activate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cleanedKey, user }),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error || 'Chave inválida.')
      const updatedUser = { ...user, ...data.userUpdate }
      await supabase.from('users').update({ premium: true, access_key: cleanedKey, premium_expires_at: data.userUpdate.premiumExpiresAt }).eq('id', user.id)
      setUser(updatedUser); localStorage.setItem(USER_SESSION_KEY, JSON.stringify(updatedUser))
      setProfileForm(prev => ({ ...prev, ...updatedUser }))
      setActivationStatus({ type: 'success', text: '✅ Premium ativado!' }); setActivationKey('')
    } catch { setActivationStatus({ type: 'error', text: 'Erro de conexão.' }); }
  }

  function toggleSelect(jobId) {
    if (isDemoBlocked || finalBlocked) return
    if (sentIds.has(jobId) || queuedIds.has(jobId)) { setJobMessage({ type: 'error', text: 'Já enviada ou na fila.' }); return }
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
      id: createQueueId(), jobId: job.id, jobTitle: job.title, employer: job.employer, contact: job.contact,
      seasonId: selectedSeason, createdAt: new Date().toISOString(), status: 'queued',
    }))
    setQueue(p => [...p, ...newItems]); setSelectedIds([]); setQueueRunning(true)
    setJobMessage({ type: 'success', text: `${newItems.length} vagas adicionadas à fila.` })
  }

  // ===================== RENDERIZAÇÃO =====================
  return (
    <div className="app">
      {syncing && <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#1a3a8f', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, zIndex: 9999 }}>🔄 Sincronizando...</div>}
      {page === 'home' && <Home onRegister={() => setPage('register')} onLogin={() => setPage('login')} />}
      {page === 'login' && (<AuthShell><form className="auth-card" onSubmit={handleLogin}><BrandBlock /><h2>Fazer login</h2>{loginError && <div className="alert error">{loginError}</div>}{/* Campos omitidos para brevidade, mantenha seus HTML originais aqui */}<label>E-mail<input type="email" value={loginForm.email} onChange={e => setLoginForm(p => ({ ...p, email: e.target.value }))} /></label><label>Senha<input type="password" value={loginForm.password} onChange={e => setLoginForm(p => ({ ...p, password: e.target.value }))} /></label><button className="primary-btn" type="submit">Entrar</button></form></AuthShell>)}
      {/* ... Mantenha o resto do JSX (register, dashboard, jobs, etc.) exatamente como estava antes ... */}
      {/* Nota: Para este exemplo, apenas os componentes críticos foram mostrados. Cole todo o restante do seu JSX original aqui. */}
      
      {/* Exemplo simplificado do retorno completo, certifique-se de colar TODOS os componentes restantes do seu código original abaixo desta linha */}
      {page === 'register' && <AuthShell><form className="auth-card large" onSubmit={handleRegister}><BrandBlock /><h2>Cadastro</h2>{/* Campos completos aqui */}</form></AuthShell>}
      {page === 'dashboard' && <Dashboard /* props... */ />}
      {page === 'jobs' && <JobsPage /* props... */ />}
      {page === 'profile' && <AuthShell><form className="auth-card large" onSubmit={saveProfile}><BrandBlock /><h2>Perfil</h2>{/* Campos completos aqui */}</form></AuthShell>}
      {page !== 'home' && <GlobalFooter />}
    </div>
  )
}

// ===================== COMPONENTES =====================
function Home({ onRegister, onLogin }) { return (<main className="home home-premium"><div className="home-overlay"/><section className="home-stage"><div className="home-brand-side"><div className="home-brand-big"><div className="home-brand-logo"><RotatingLogo/></div><div className="home-brand-text"><h1>FUTURE EUA H2B</h1><p>Rumo ao sonho americano</p></div></div></div><div className="home-hero-card"><span className="pill">Brasil → Estados Unidos</span><h2>Organize suas candidaturas H2B</h2><p>Sistema para cadastro e controle de vagas.</p><div className="home-actions premium-home-actions"><button className="primary-btn" onClick={onRegister}>Cadastrar-se</button><button className="ghost-light-btn" onClick={onLogin}>Fazer login</button></div></div></section></main>) }
function AuthShell({ children }) { return <main className="auth-shell"><div className="auth-bg"/>{children}</main> }
function BrandBlock() { return <div className="brand-block"><RotatingLogo/><div><h1>FUTURE EUA H2B</h1><p>Rumo ao sonho americano</p></div></div> }
function RotatingLogo() { return <div className="rotating-logo logo-image"><img src="/logo-br-us.png" alt="Future EUA H2B"/></div> }
function Field({ label, value, onChange, type='text', error, disabled }) { return (<label className={`${error?'has-error':''} ${disabled?'field-disabled':''}`}>{label}<input type={type} value={value||''} disabled={disabled} onChange={e=>{if(!disabled)onChange(e.target.value)}}/>{error&&<span className="field-error">{error}</span>}</label>) }
function Dashboard(/* props */) { /* Copie o código completo deste componente do seu arquivo original aqui */ return <div>Dashboard Placeholder - Cole o código original aqui</div> }
function JobsPage(/* props */) { /* Copie o código completo deste componente do seu arquivo original aqui */ return <div>Vagas Placeholder - Cole o código original aqui</div> }
function TopBar(/* props */) { /* Copie o código completo deste componente do seu arquivo original aqui */ return <div>TopBar Placeholder</div> }
function Avatar({ user, size='' }) { return user?.avatar ? <img className={`avatar ${size}`} src={user.avatar} alt={user.name}/> : <div className={`avatar initials ${size}`}>{getInitials(user?.name)}</div> }
function StatCard({ title, value }) { return <div className="stat-card"><span>{title}</span><strong>{value}</strong></div> }
function InfoLine({ label, value }) { return <div className="info-line"><span>{label}</span><strong>{value}</strong></div> }
function GlobalFooter() { return <footer className="global-footer"><p>⚠️ A plataforma não garante vaga.</p><p>Crédito de dados: seasonaljobs.dol.gov</p><hr style={{border:'none', borderTop:'1px solid rgba(255,255,255,0.1)', margin:'20px auto', maxWidth:'600px'}}/><div style={{marginTop:'16px', textAlign:'center'}}><p style={{fontWeight:'bold', fontSize:'15px', color:'#facc15', marginBottom:'8px'}}>© {new Date().getFullYear()} Bymagno_rust</p><p style={{fontSize:'13px', opacity:0.85}}>📧 magno.elen2023@gmail.com</p></div></footer> }