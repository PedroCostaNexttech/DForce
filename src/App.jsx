import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { getPreviewPayload, parseMaybeJson, parseNotes, resolveTeamName } from './lib/notes'

function normalizeN8nBaseUrl(value) {
  const baseUrl = String(import.meta.env.PROD ? '/webhook' : value || 'http://127.0.0.1:5678/webhook').replace(/\/+$/, '')
  return /\/webhook$/i.test(baseUrl) ? baseUrl : `${baseUrl}/webhook`
}

const N8N_BASE_URL = normalizeN8nBaseUrl(import.meta.env.VITE_N8N_BASE_URL)

const TOURNAMENT_WORKFLOWS = [
  {
    key: 'sorteio',
    label: 'Gerar Sorteio',
    description: 'Cria os jogos a partir do ficheiro de equipas.',
    webhook: 'sorteio-ficheiro',
    expectsMatches: true,
    needsFile: true,
  },
  {
    key: 'criar-torneio',
    label: 'Criar Torneio',
    description: 'Regista o torneio e a configuração base.',
    webhook: 'torneio-criar',
    needsFile: true,
  },
  {
    key: 'atualizar-equipas',
    label: 'Atualizar Equipas',
    description: 'Sincroniza equipas inscritas a partir do ficheiro.',
    webhook: 'torneio-equipas',
    needsFile: true,
  },
  {
    key: 'registar-resultados',
    label: 'Registar Resultados',
    description: 'Envia resultados ou ocorrências para o torneio.',
    webhook: 'torneio-resultados',
    needsResults: true,
  },
  {
    key: 'classificacoes',
    label: 'Classificações',
    description: 'Recalcula ou consulta classificações.',
    webhook: 'torneio-classificacoes',
  },
  {
    key: 'calendario',
    label: 'Calendário',
    description: 'Gera ou sincroniza calendário operacional.',
    webhook: 'torneio-calendario',
  },
  {
    key: 'exportar',
    label: 'Exportar Gestão',
    description: 'Exporta dados consolidados do torneio.',
    webhook: 'torneio-exportar',
  },
]

const DRAW_FORMATS = [
  {
    key: 'champions',
    label: 'Champions',
    description: 'Grupos com fase a eliminar. Define quantas equipas passam por grupo.',
    webhook: 'sorteio-champions',
  },
  {
    key: 'grupos',
    label: 'Fase de grupos',
    description: 'Sorteio de grupos com jogos todos contra todos dentro de cada grupo.',
    webhook: 'sorteio-grupos',
  },
  {
    key: 'liga',
    label: 'Liga',
    description: 'Todos contra todos numa tabela geral, sem fase eliminatória.',
    webhook: 'sorteio-liga',
  },
  {
    key: 'qualificacao',
    label: 'Qualificação',
    description: 'Grupos de qualificação com calendário completo por grupo.',
    webhook: 'sorteio-qualificacao',
  },
  {
    key: 'eliminatorias',
    label: 'Eliminatórias',
    description: 'Quadro a eliminar com rondas até à final.',
    webhook: 'sorteio-eliminatorias',
  },
  {
    key: 'taca',
    label: 'Taça',
    description: 'Formato de taça em eliminatórias diretas.',
    webhook: 'sorteio-taca',
  },
]

const SUPPORTED_FILE_TYPES = new Set([
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  'application/octet-stream',
])

const SUPPORTED_FILE_EXTENSIONS = ['.pdf', '.csv', '.xls', '.xlsx', '.xlsm', '.xlsb']

let pdfRuntimePromise

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function detectDrawFormatFromFileName(fileName) {
  const name = normalizeText(fileName)
  if (!name) return ''

  const checks = [
    ['champions', /\bchampions?\b|champ/i],
    ['qualificacao', /qualific/i],
    ['eliminatorias', /eliminator|eliminatoria|knockout/i],
    ['grupos', /\bgrupos?\b|fase[-_\s]*de[-_\s]*grupos?/i],
    ['liga', /\bliga\b|league/i],
    ['taca', /\btaca\b|\bcup\b/i],
  ]

  const match = checks.find(([, pattern]) => pattern.test(name))
  return match?.[0] || ''
}

async function getPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, workerModule]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default
      return pdfjs
    })
  }
  return pdfRuntimePromise
}

function initialCampos(count = 2) {
  return Array.from({ length: count }, (_, index) => `Campo ${index + 1}`)
}

function getInitials(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() || '')
    .join('')
}

function phaseOrder(phase) {
  const value = String(phase || '').toLowerCase()
  if (value.includes('grupo') || value.includes('jornada')) return 0
  if (value.includes('oitav')) return 1
  if (value.includes('quart')) return 2
  if (value.includes('meia') || value.includes('semi')) return 3
  if (value === 'final') return 4
  return 5
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' }).replace('.', '')
}

function isKO(phase) {
  const value = String(phase).toLowerCase()
  return !value.includes('grupo') && !value.includes('jornada')
}

function getGroupLabel(phase) {
  const value = String(phase || '')
  const match = value.match(/grupo\s*([A-Z0-9]+)/i)
  if (match) return `Grupo ${match[1].toUpperCase()}`
  return value
}

function getPhaseDisplayLabel(phase) {
  const value = String(phase || '').trim()
  const lower = value.toLowerCase()

  if (!value) return ''
  if (lower.includes('grupo')) return getGroupLabel(value)
  if (lower.includes('oitav')) return 'Oitavos de Final'
  if (lower.includes('quart')) return 'Quartos de Final'
  if (lower.includes('meia') || lower.includes('semi')) return 'Meias-Finais'
  if (lower === 'final') return 'Final'

  return value
}

function formatGroupPhase(groupValue) {
  const value = String(groupValue || '').trim()
  if (!value) return ''
  if (/^grupo\s*[A-Z0-9]+$/i.test(value)) return getGroupLabel(value)
  return `Grupo ${value.toUpperCase()}`
}

function createTeamMap(teamList) {
  return teamList.reduce((map, team) => {
    map[team] = team
    return map
  }, {})
}

const TEAM_NOISE_WORDS = [
  'dragon force',
  'sorteio',
  'resultado',
  'jornada',
  'fase',
  'grupo',
  'equipa',
  'equipas',
  'campo',
  'hora',
  'data',
  'duracao',
  'estado',
  'agendado',
  'casa',
  'fora',
]

function normalizeTeamKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyTeamName(value) {
  const text = String(value || '').trim()
  if (!text || text.length < 3 || text.length > 80) return false
  if (/^\d+$/.test(text)) return false
  if (/^\d{1,2}[/:\-]\d{1,2}/.test(text)) return false
  if (/^\d{1,2}:\d{2}$/.test(text)) return false
  if ((text.match(/\d/g) || []).length > 4) return false
  if (!/[A-Za-zÀ-ÿ]/.test(text)) return false

  const normalized = normalizeTeamKey(text)
  if (!normalized) return false
  if (TEAM_NOISE_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `))) return false
  if (/^(vs?|x|-|—)$/i.test(normalized)) return false

  return true
}

function pushTeamCandidate(set, candidate) {
  const raw = String(candidate || '')
    .replace(/^[\d\s).\-]+/, '')
    .replace(/[|;]+$/g, '')
    .trim()

  if (!isLikelyTeamName(raw)) return
  set.add(raw)
}

function extractTeamsFromText(text) {
  const teams = new Set()

  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const versus = line.split(/\s+(?:vs\.?|x)\s+/i)
      if (versus.length === 2) {
        pushTeamCandidate(teams, versus[0])
        pushTeamCandidate(teams, versus[1])
        return
      }

      line
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => pushTeamCandidate(teams, part))
    })

  const dedup = []
  const seen = new Set()
  teams.forEach((team) => {
    const key = normalizeTeamKey(team)
    if (!key || seen.has(key)) return
    seen.add(key)
    dedup.push(team)
  })

  return dedup
}

async function extractTeamsFromSpreadsheet(file) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const teams = new Set()

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    rows.forEach((row) => {
      if (!Array.isArray(row)) return
      row.forEach((cell) => {
        const text = String(cell || '').trim()
        if (!text) return
        extractTeamsFromText(text).forEach((team) => teams.add(team))
      })
    })
  })

  return [...teams]
}

async function extractTeamsFromPdf(file) {
  const pdfjs = await getPdfRuntime()
  const buffer = await file.arrayBuffer()
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) })
  const pdf = await loadingTask.promise
  const chunks = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const pageText = textContent.items
      .map((item) => item?.str || '')
      .join('\n')
    chunks.push(pageText)
  }

  return extractTeamsFromText(chunks.join('\n'))
}

async function extractTeamsFromFile(file) {
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
    return extractTeamsFromSpreadsheet(file)
  }
  if (name.endsWith('.pdf')) {
    return extractTeamsFromPdf(file)
  }
  return []
}

function normalizeMatch(raw, index = 0, phaseFallback = 'Fase') {
  if (!raw || typeof raw !== 'object') return null

  const homeTeam = raw.homeTeam || raw.home_team || raw.home || raw.casa || ''
  const awayTeam = raw.awayTeam || raw.away_team || raw.away || raw.fora || ''
  if (!homeTeam || !awayTeam) return null

  const rawGroup = raw.group || raw.groupName || raw.grupo || raw.group_id || raw.groupId
  const phase = raw.phase || raw.fase || raw.round || (rawGroup ? formatGroupPhase(rawGroup) : phaseFallback)
  const id = raw.id || `${String(phase)}-${String(homeTeam)}-${String(awayTeam)}-${index}`

  return {
    ...raw,
    id,
    phase,
    group: rawGroup ? formatGroupPhase(rawGroup) : raw.group,
    homeTeam,
    awayTeam,
    date: raw.date || raw.data || '',
    time: raw.time || raw.hora || '',
    venue: raw.venue || raw.campo || '',
    duration: Number(raw.duration || raw.duracao || 0) || undefined,
    status: raw.status || 'Agendado',
  }
}

function shuffleArray(array) {
  const a = Array.from(array)
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

function generateGroupMatches(teams = [], groupSize = 4) {
  if (!teams || !teams.length) return []
  const numGroups = Math.max(1, Math.ceil(teams.length / groupSize))
  const groups = Array.from({ length: numGroups }, () => [])
  teams.forEach((team, idx) => groups[idx % numGroups].push(team))

  const matches = []
  groups.forEach((groupTeams, gIndex) => {
    const groupLabel = String.fromCharCode(65 + gIndex)
    const phase = formatGroupPhase(`grupo ${groupLabel}`)
    for (let i = 0; i < groupTeams.length; i += 1) {
      for (let j = i + 1; j < groupTeams.length; j += 1) {
        matches.push({ id: `gen-${phase}-${gIndex}-${i}-${j}`, phase, homeTeam: groupTeams[i], awayTeam: groupTeams[j] })
      }
    }
  })
  return matches
}

function generateKnockoutMatches(teams = []) {
  if (!teams || !teams.length) return []
  const shuffled = shuffleArray(teams)
  const matches = []
  const phase = shuffled.length > 8 ? 'Oitavos' : 'Primeira Ronda'
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    matches.push({ id: `gen-${phase}-${i}`, phase, homeTeam: shuffled[i], awayTeam: shuffled[i + 1] })
  }
  return matches
}

function extractMatchesFromN8nResponse(responseData, fallbackFormat = 'champions') {
  if (!responseData) return []

  const candidates = []

  const pushFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return
    if (Array.isArray(payload.matches)) candidates.push(...payload.matches)
    if (Array.isArray(payload.groupMatches)) candidates.push(...payload.groupMatches)
    if (Array.isArray(payload.knockoutMatches)) candidates.push(...payload.knockoutMatches)

    Object.values(payload).forEach((value) => {
      if (!Array.isArray(value)) return
      if (value.every((entry) => entry && typeof entry === 'object' && (entry.homeTeam || entry.home || entry.casa) && (entry.awayTeam || entry.away || entry.fora))) {
        candidates.push(...value)
      }
    })
  }

  // direct API shape: { matches: [...] }
  if (responseData && typeof responseData === 'object' && !Array.isArray(responseData)) {
    pushFromPayload(responseData)
    if (responseData.data && typeof responseData.data === 'object') pushFromPayload(responseData.data)
    if (responseData.body && typeof responseData.body === 'object') pushFromPayload(responseData.body)
    if (responseData.result && typeof responseData.result === 'object') pushFromPayload(responseData.result)
  }

  // n8n common shape: [{ json: {...} }]
  const n8nItems = Array.isArray(responseData)
    ? responseData
    : Array.isArray(responseData.items)
      ? responseData.items
      : []

  n8nItems.forEach((item) => {
    const payload = item?.json || item
    if (!payload || typeof payload !== 'object') return
    pushFromPayload(payload)
    if (payload.data && typeof payload.data === 'object') pushFromPayload(payload.data)
    if (payload.body && typeof payload.body === 'object') pushFromPayload(payload.body)
    if (payload.result && typeof payload.result === 'object') pushFromPayload(payload.result)
  })

  // dedupe + normalize
  const seen = new Set()
  const normalized = []
  candidates.forEach((candidate, index) => {
    const match = normalizeMatch(candidate, index)
    if (!match) return
    const key = `${match.phase}|${match.homeTeam}|${match.awayTeam}|${match.date}|${match.time}`
    if (seen.has(key)) return
    seen.add(key)
    normalized.push(match)
  })

  // If we didn't find structured matches but the response is a plain array of team names, generate fallback matches client-side
  if (!normalized.length) {
    // responseData may itself be an array of strings
    const flatArray = Array.isArray(responseData) ? responseData : Array.isArray(responseData.items) ? responseData.items : null
    const teamList = Array.isArray(flatArray) && flatArray.every((t) => typeof t === 'string') ? flatArray : null
    if (teamList && teamList.length) {
      const teams = teamList.map((t) => String(t).trim()).filter(Boolean)
      if (fallbackFormat === 'grupos') {
        return generateGroupMatches(teams)
      }
      return generateKnockoutMatches(teams)
    }
  }

  return normalized
}

function getWorkflowUrl(workflow) {
  const path = workflow?.webhook || ''
  if (/^https?:\/\//i.test(path)) return path
  return `${N8N_BASE_URL}/${path.replace(/^\/+/, '')}`
}

function getDrawWorkflowUrl(workflow, formatConfig) {
  if (workflow?.key !== 'sorteio') return getWorkflowUrl(workflow)
  const path = formatConfig?.webhook || workflow?.webhook || ''
  if (/^https?:\/\//i.test(path)) return path
  return `${N8N_BASE_URL}/${path.replace(/^\/+/, '')}`
}

function appendJson(formData, key, value) {
  formData.append(key, JSON.stringify(value ?? null))
}

async function readN8nResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  const rawText = await response.text().catch(() => '')
  const trimmed = rawText.trim()

  if (!trimmed) {
    return { data: null, rawText, contentType }
  }

  const looksLikeJson = contentType.includes('application/json') || /^[\[{]/.test(trimmed)
  if (looksLikeJson) {
    try {
      return { data: JSON.parse(trimmed), rawText, contentType }
    } catch (error) {
      return { data: null, rawText, contentType, parseError: error }
    }
  }

  return { data: null, rawText, contentType }
}

export default function App() {
  const [selectedFormat, setSelectedFormat] = useState('champions')
  const [selectedWorkflow, setSelectedWorkflow] = useState('sorteio')
  const [selectedFile, setSelectedFile] = useState(null)
  const [tournamentName, setTournamentName] = useState('')
  const [tournamentId, setTournamentId] = useState('')
  const [resultsText, setResultsText] = useState('')
  const [durationMode] = useState('escalao')
  const [drawCounter, setDrawCounter] = useState(0)
  const [notes, setNotes] = useState('')
  const [notesConfirmed, setNotesConfirmed] = useState(true)
  const [numCampos, setNumCampos] = useState(2)
  const [campos, setCampos] = useState(initialCampos(2))
  const [dataInicio, setDataInicio] = useState('')
  const [horaInicio, setHoraInicio] = useState('09:00')
  const [transicao, setTransicao] = useState(5)
  const [duracao, setDuracao] = useState(45)
  const [resultMatches, setResultMatches] = useState([])
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(0)
  const [expandedPhaseIndex, setExpandedPhaseIndex] = useState(0)
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState(0)
  const [selectedGroupPhaseIndex, setSelectedGroupPhaseIndex] = useState(0)
  const [selectedGroupTeam, setSelectedGroupTeam] = useState('')
  const [extractedTeams, setExtractedTeams] = useState([])
  const [lastResponseDebug, setLastResponseDebug] = useState(null)
  const [allPhases, setAllPhases] = useState([])
  const [lastMatchesData, setLastMatchesData] = useState([])
  const [workflowResponse, setWorkflowResponse] = useState(null)
  const [fileName, setFileName] = useState('ficheiro.pdf')
  const [detectedFileFormat, setDetectedFileFormat] = useState('')
  const [formatMismatchConfirmed, setFormatMismatchConfirmed] = useState(false)

  const activeWorkflow = useMemo(
    () => TOURNAMENT_WORKFLOWS.find((workflow) => workflow.key === selectedWorkflow) || TOURNAMENT_WORKFLOWS[0],
    [selectedWorkflow],
  )
  const selectedFormatConfig = useMemo(
    () => DRAW_FORMATS.find((format) => format.key === selectedFormat) || DRAW_FORMATS[0],
    [selectedFormat],
  )
  const detectedFileFormatConfig = useMemo(
    () => DRAW_FORMATS.find((format) => format.key === detectedFileFormat) || null,
    [detectedFileFormat],
  )
  const hasFormatMismatch = !!selectedFile && !!detectedFileFormat && detectedFileFormat !== selectedFormat
  const previewPayload = useMemo(() => getPreviewPayload(notes, extractedTeams), [notes, extractedTeams])
  const hasStructuredNotes = previewPayload.ordemNotas.length > 0 || previewPayload.gruposNotas.length > 0 || Object.keys(previewPayload.earliestTimes).length > 0 || previewPayload.restrictions.length > 0

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    setDataInicio(today)
  }, [])

  useEffect(() => {
    setCampos(initialCampos(numCampos))
  }, [numCampos])

  // Notes preview removed: keep notes confirmed by default

  useEffect(() => {
    setExpandedPhaseIndex(currentPhaseIndex)
  }, [currentPhaseIndex, resultMatches.length])

  useEffect(() => {
    setSelectedGroupTeam('')
  }, [selectedPhaseIndex, resultMatches.length])

  async function handleFileChange(event) {
    const file = event.target.files?.[0]
    if (!file) return

    const fileType = String(file.type || '').toLowerCase()
    const fileNameLower = String(file.name || '').toLowerCase()
    const hasSupportedExtension = SUPPORTED_FILE_EXTENSIONS.some((extension) => fileNameLower.endsWith(extension))
    const hasSupportedType = SUPPORTED_FILE_TYPES.has(fileType)

    if (!hasSupportedType && !hasSupportedExtension) {
      setSelectedFile(null)
      setExtractedTeams([])
      setDetectedFileFormat('')
      setFormatMismatchConfirmed(false)
      setFileName('ficheiro não suportado')
      showError(`Escolhe um ficheiro PDF, CSV, XLS, XLSX, XLSM ou XLSB. Tipo detetado: "${file.type || 'desconhecido'}" Extensão: "${file.name.split('.').pop() || 'desconhecida'}"`)
      return
    }

    try {
      const detectedFormat = detectDrawFormatFromFileName(file.name)
      const teams = await extractTeamsFromFile(file)
      if (!teams.length) {
        throw new Error(`Não foi possível extrair equipas do ficheiro selecionado. Tipo: "${file.type || 'desconhecido'}" Ext: "${file.name.split('.').pop() || 'desconhecida'}"`)
      }

      setSelectedFile(file)
      setExtractedTeams(teams)
      setDetectedFileFormat(detectedFormat)
      setFormatMismatchConfirmed(false)
      if (detectedFormat) setSelectedFormat(detectedFormat)
      setFileName(`${file.name} (${teams.length} equipas)`)
      setNotesConfirmed(true)
      setError('')
    } catch (err) {
      setSelectedFile(null)
      setExtractedTeams([])
      setDetectedFileFormat('')
      setFormatMismatchConfirmed(false)
      setFileName(file.name)
      showError(`Erro ao ler ficheiro: ${err.message}`)
    }
  }

  function updateSelectedFormat(format) {
    setSelectedFormat(format)
    setFormatMismatchConfirmed(false)
  }

  function showError(message) {
    setError(message)
    setSuccessMessage('')
  }

  function hideError() {
    setError('')
  }

  function showSuccess(message) {
    setSuccessMessage(message)
    setError('')
  }

  function updateField(index, value) {
    setCampos((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)))
  }

  

  function scheduleMatches(matches, options = {}) {
    const force = !!options.force
    if (!matches || !matches.length) return matches
    if (!campos.length) return matches

    const startDate = dataInicio || new Date().toISOString().split('T')[0]
    const startTime = horaInicio || '09:00'
    const transition = Number(transicao) || 0
    const durationMinutes = Number(duracao) || 45

    const parseDateTime = (dateValue, timeValue) => {
      const [year, month, day] = String(dateValue).split('-').map(Number)
      const [hours, minutes] = String(timeValue || '00:00').split(':').map(Number)
      return new Date(year, month - 1, day, hours, minutes)
    }

    const nextAvailable = {}
    campos.forEach((campo) => {
      nextAvailable[campo] = parseDateTime(startDate, startTime)
    })

    matches.forEach((match) => {
      if (!options.force && match.venue && (match.date || match.time)) {
        const dateValue = match.date || startDate
        const timeValue = match.time || startTime
        const end = new Date(parseDateTime(dateValue, timeValue).getTime() + (Number(match.duration || durationMinutes) + transition) * 60000)
        if (nextAvailable[match.venue] && end > nextAvailable[match.venue]) {
          nextAvailable[match.venue] = end
        }
      }
    })

    if (options.priorityTeams?.length) {
      const rank = new Map(options.priorityTeams.map((team, index) => [String(team).toLowerCase(), index]))
      const score = (match) => {
        const home = rank.has(String(match.homeTeam || '').toLowerCase()) ? rank.get(String(match.homeTeam || '').toLowerCase()) : Number.POSITIVE_INFINITY
        const away = rank.has(String(match.awayTeam || '').toLowerCase()) ? rank.get(String(match.awayTeam || '').toLowerCase()) : Number.POSITIVE_INFINITY
        return Math.min(home, away)
      }
      matches.sort((a, b) => score(a) - score(b) || phaseOrder(a.phase) - phaseOrder(b.phase))
    }

    matches.forEach((match) => {
      if (!options.force && match.venue && match.time) return

      const teamEarliest = (team) => {
        if (!options.earliestTimes) return null
        const time = options.earliestTimes[team] || options.earliestTimes[String(team).toLowerCase()]
        return time ? parseDateTime(startDate, time) : null
      }

      let chosenCampo = campos[0]
      let bestTime = null
      campos.forEach((campo) => {
        const base = nextAvailable[campo] || parseDateTime(startDate, startTime)
        const homeRequired = teamEarliest(match.homeTeam) || teamEarliest(match.home_team)
        const awayRequired = teamEarliest(match.awayTeam) || teamEarliest(match.away_team)
        let candidate = base
        if (homeRequired && homeRequired > candidate) candidate = homeRequired
        if (awayRequired && awayRequired > candidate) candidate = awayRequired
        if (!bestTime || candidate < bestTime) {
          chosenCampo = campo
          bestTime = candidate
        }
      })

      const dt = new Date(bestTime || nextAvailable[chosenCampo] || parseDateTime(startDate, startTime))
      match.date = dt.toISOString().slice(0, 10)
      match.time = dt.toTimeString().slice(0, 5)
      match.venue = chosenCampo
      nextAvailable[chosenCampo] = new Date(dt.getTime() + (Number(match.duration || durationMinutes) + transition) * 60000)
    })

    return matches
  }

  function applyNoteRules(matches, payload = previewPayload) {
    if (!matches?.length) return matches

    const restrictions = payload.restrictions
    const sameJornadas = []
    const notSameGroup = []

    notes.split(/\r?\n/).forEach((line) => {
      const text = line.trim()
      if (!text) return
      const pairMatch = text.match(/(.+?)\s+e\s+(.+?)\s+jogam juntas na jornada\s*(\d+)/i)
      if (pairMatch) sameJornadas.push({ a: pairMatch[1].trim(), b: pairMatch[2].trim(), jornada: pairMatch[3].trim() })
      const groupMatch = text.match(/(.+?)\s+e\s+(.+?)\s+(?:nao|não)\s+podem estar no mesmo grupo/i)
      if (groupMatch) notSameGroup.push({ a: groupMatch[1].trim(), b: groupMatch[2].trim() })
    })

    const warnings = []

    const findMatchesFor = (team) => matches.filter((match) => String(match.homeTeam || '').toLowerCase() === String(team).toLowerCase() || String(match.awayTeam || '').toLowerCase() === String(team).toLowerCase())

    restrictions.forEach((rule) => {
      const jornadaRe = new RegExp(rule.jornada, 'i')
      matches.forEach((match) => {
        if (!match.phase || !jornadaRe.test(String(match.phase))) return
        if (rule.type === 'notAway' && String(match.awayTeam || '').toLowerCase() === String(rule.team).toLowerCase()) {
          const temp = match.homeTeam
          match.homeTeam = match.awayTeam
          match.awayTeam = temp
          warnings.push(`${rule.team} não jogou fora na ${match.phase} — invertido casa/fora`)
        }
        if (rule.type === 'notHome' && String(match.homeTeam || '').toLowerCase() === String(rule.team).toLowerCase()) {
          const temp = match.homeTeam
          match.homeTeam = match.awayTeam
          match.awayTeam = temp
          warnings.push(`${rule.team} não jogou em casa na ${match.phase} — invertido casa/fora`)
        }
      })
    })

    sameJornadas.forEach((pair) => {
      const ma = findMatchesFor(pair.a)[0]
      const mb = findMatchesFor(pair.b)[0]
      if (!ma || !mb) {
        warnings.push(`Não foi possível localizar ambos os jogos para ${pair.a} e ${pair.b}`)
        return
      }
      if (ma.date && mb.date && ma.date !== mb.date) {
        const earlier = ma.date < mb.date ? ma.date : mb.date
        ma.date = earlier
        mb.date = earlier
        warnings.push(`${pair.a} e ${pair.b} alinhados para a mesma jornada (dia ${earlier})`)
      }
    })

    notSameGroup.forEach((pair) => {
      const ma = findMatchesFor(pair.a)[0]
      const mb = findMatchesFor(pair.b)[0]
      if (!ma || !mb) return
      if (ma.phase && mb.phase && ma.phase === mb.phase && /grupo/i.test(ma.phase)) {
        warnings.push(`${pair.a} e ${pair.b} estão no mesmo grupo (${ma.phase})`)
      }
    })

    if (warnings.length) setError(`Avisos: ${warnings.join(' | ')}`)
    return matches
  }

  function buildTournamentFormData(teams, parsedPayload) {
    const formData = new FormData()
    if (selectedFile) {
      formData.append('file', selectedFile)
      formData.append('ficheiro', selectedFile)
      formData.append('document', selectedFile)
      formData.append('uploadedFile', selectedFile)
      formData.append('fileName', selectedFile.name)
    }
    formData.append('workflow', selectedWorkflow)
    formData.append('torneioId', tournamentId.trim())
    formData.append('tournamentId', tournamentId.trim())
    formData.append('nomeTorneio', tournamentName.trim())
    formData.append('tournamentName', tournamentName.trim())
    formData.append('formato', selectedFormat)
    appendJson(formData, 'equipas', teams)
    appendJson(formData, 'teams', teams)
    try {
      teams.forEach((t) => {
        formData.append('equipas[]', t)
        formData.append('teams[]', t)
      })
    } catch (e) {
      // ignore if FormData append fails for some reason
    }
    formData.append('equipas_plain', teams.join('|'))
    formData.append('teams_plain', teams.join('|'))
    formData.append('notas', notes.trim())
    appendJson(formData, 'ordemNotas', parsedPayload.ordemNotas)
    appendJson(formData, 'gruposNotas', parsedPayload.gruposNotas)
    appendJson(formData, 'earliestTimes', parsedPayload.earliestTimes)
    appendJson(formData, 'restrictions', parsedPayload.restrictions)
    formData.append('resultados', resultsText.trim())
    formData.append('results', resultsText.trim())
    formData.append('dataInicio', dataInicio)
    formData.append('horaInicio', horaInicio)
    formData.append('transicao', String(transicao))
    appendJson(formData, 'campos', campos)
    formData.append('durationMode', durationMode)
    appendJson(formData, 'duration', duracao)
    appendJson(formData, 'championsConfig', { origemEquipas: selectedFile ? 'ficheiro' : 'manual', formato: selectedFormat })
    formData.append('seed', Math.random().toString(36).slice(2))
    return formData
  }

  async function submitWorkflow() {
    if (activeWorkflow.needsFile && !selectedFile) {
      showError('Carrega um ficheiro de equipas antes de executar este fluxo.')
      return
    }
    if (activeWorkflow.needsResults && !resultsText.trim()) {
      showError('Preenche os resultados ou ocorrências antes de executar este fluxo.')
      return
    }
    if (activeWorkflow.key === 'sorteio' && hasFormatMismatch && !formatMismatchConfirmed) {
      showError('')
      return
    }

    const today = new Date().toISOString().split('T')[0]
    if (dataInicio && dataInicio < today) {
      showError('A data de início não pode ser anterior a hoje.')
      return
    }

    setLoading(true)
    hideError()
    setSuccessMessage('')
    setResultMatches([])
    setWorkflowResponse(null)
    setLastResponseDebug(null)

    try {
      const teams = extractedTeams.length ? extractedTeams : selectedFile ? await extractTeamsFromFile(selectedFile) : []
      if (activeWorkflow.needsFile && !teams.length) {
        throw new Error('Não foi possível extrair equipas do ficheiro antes de enviar ao fluxo.')
      }

      const parsedPayload = getPreviewPayload(notes, teams)
      const formData = buildTournamentFormData(teams, parsedPayload)

      const parsedHasStructuredNotes =
        parsedPayload.ordemNotas.length > 0 ||
        parsedPayload.gruposNotas.length > 0 ||
        Object.keys(parsedPayload.earliestTimes).length > 0 ||
        parsedPayload.restrictions.length > 0

      if (parsedHasStructuredNotes && !notesConfirmed) {
        showError('Por favor, confirme as notas no painel de pré-visualização antes de executar o fluxo.')
        return
      }

      const response = await fetch(getDrawWorkflowUrl(activeWorkflow, selectedFormatConfig), { method: 'POST', body: formData })
      const responseBody = await readN8nResponse(response)
      if (!response.ok) {
        const rawMessage = responseBody.rawText?.trim()
        const parsedMessage = responseBody.data && typeof responseBody.data === 'object'
          ? responseBody.data.message || responseBody.data.error || responseBody.data.detail
          : ''
        const extra = [
          `HTTP ${response.status}`,
          responseBody.contentType ? `content-type: ${responseBody.contentType}` : '',
          rawMessage ? `corpo: ${rawMessage.slice(0, 500)}` : 'corpo vazio',
        ].filter(Boolean).join(' | ')
        throw new Error(parsedMessage ? `${parsedMessage} | ${extra}` : extra)
      }
      const data = responseBody.data
      if (!data) {
        const extra = [
          responseBody.contentType ? `content-type: ${responseBody.contentType}` : '',
          responseBody.rawText?.trim() ? `corpo: ${responseBody.rawText.trim().slice(0, 500)}` : 'corpo vazio',
        ].filter(Boolean).join(' | ')
        throw new Error(`Resposta do n8n não é JSON. ${extra}`)
      }

      const matches = extractMatchesFromN8nResponse(data, selectedFormat)
      const shouldRenderMatches = activeWorkflow.expectsMatches || matches.length > 0
      if (shouldRenderMatches && !matches.length) {
        setLastResponseDebug(data)
        throw new Error('O n8n respondeu, mas sem jogos no formato esperado. Verifica se o último node devolve matches/groupMatches/knockoutMatches em JSON.')
      }

      setExtractedTeams(teams)
      setWorkflowResponse(data)
      showSuccess(`${activeWorkflow.label} concluído com sucesso.`)

      if (matches.length) {
        const scheduled = scheduleMatches(matches, {
          force: true,
          priorityTeams: parsedPayload.ordemNotas,
          earliestTimes: parsedPayload.earliestTimes,
        })
        applyNoteRules(scheduled, parsedPayload)
        setLastMatchesData(scheduled)
        setResultMatches(scheduled)
        setDrawCounter((current) => current + 1)
        setCurrentPhaseIndex(0)
        setExpandedPhaseIndex(0)
        setSelectedPhaseIndex(0)
        setSelectedGroupPhaseIndex(0)
        setAllPhases([...new Set(scheduled.map((match) => match.phase))].sort((a, b) => phaseOrder(a) - phaseOrder(b)))
      }
    } catch (err) {
      showError(`Erro ao contactar o fluxo "${activeWorkflow.label}": ${err.message}`)
    } finally {
      setLoading(false)
    }
  }
  const phases = useMemo(() => {
    const byPhase = {}
    resultMatches.forEach((match) => {
      if (!byPhase[match.phase]) byPhase[match.phase] = []
      byPhase[match.phase].push(match)
    })
    return Object.keys(byPhase).sort((a, b) => phaseOrder(a) - phaseOrder(b)).map((phase) => ({ phase, matches: byPhase[phase] }))
  }, [resultMatches])

  const activePhase = phases[selectedPhaseIndex] || phases[0] || null

  useEffect(() => {
    if (selectedPhaseIndex >= phases.length) setSelectedPhaseIndex(0)
  }, [phases, selectedPhaseIndex])

  return (
    <div className="app-shell">
      <div className="container">
        <header className="header">
          <div className="logo-wrap">
            <img src="/imagens/logo.png" alt="Dragon Force" className="shield" />
          </div>
          <h1 className="page-title">MOTOR DE <span>SORTEIO</span></h1>
          <p className="page-sub">Configure o torneio, carregue as equipas e gere o sorteio automaticamente</p>
        </header>

        <section className="card">
          <div className="card-header"><span className="section-label">Gestão do Torneio</span></div>
          <div className="grid-2">
            <div className="field">
              <label>Nome do Torneio</label>
              <input type="text" value={tournamentName} onChange={(event) => setTournamentName(event.target.value)} />
            </div>
            <div className="field">
              <label>ID do Torneio</label>
              <input type="text" value={tournamentId} onChange={(event) => setTournamentId(event.target.value)} placeholder="Opcional" />
            </div>
          </div>
          {activeWorkflow.needsResults && (
            <div style={{ padding: '0 24px 20px' }}>
              <div className="field">
                <label>Resultados / Ocorrências</label>
                <textarea
                  value={resultsText}
                  onChange={(event) => setResultsText(event.target.value)}
                  placeholder="Exemplo: FC Porto 2-1 Sporting CP; Benfica 0-0 Braga"
                />
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-header"><span className="section-label">Formato do Sorteio</span></div>
          <div className="format-grid">
            {DRAW_FORMATS.map((option) => (
              <button key={option.key} type="button" aria-pressed={selectedFormat === option.key} className={`format-btn ${selectedFormat === option.key ? 'active' : ''}`} onClick={() => updateSelectedFormat(option.key)}>
                <div className="format-name">{option.label}</div>
                <div className="format-desc">{option.description}</div>
                <div className="format-auto-badge" style={{ display: 'none' }}>Sugerido para as tuas equipas</div>
              </button>
            ))}
          </div>
          {hasFormatMismatch && !formatMismatchConfirmed && (
            <div className="compatibility-warning" role="alert">
              <div className="compatibility-warning__title">Formatos incompatíveis</div>
              <p>
                O ficheiro parece ser de <strong>{detectedFileFormatConfig?.label}</strong>, mas o torneio está definido como <strong>{selectedFormatConfig.label}</strong>.
                Deseja proceder mesmo assim?
              </p>
              <div className="compatibility-warning__actions">
                <button type="button" className="secondary-btn" onClick={() => updateSelectedFormat(detectedFileFormat)}>
                  Usar {detectedFileFormatConfig?.label}
                </button>
                <button type="button" className="warning-confirm-btn" onClick={() => setFormatMismatchConfirmed(true)}>
                  Proceder
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-header"><span className="section-label">Data e Hora do Torneio</span></div>
          <div className="grid-3">
            <div className="field">
              <label>Data de Início</label>
              <input type="date" value={dataInicio} onChange={(event) => setDataInicio(event.target.value)} />
            </div>
            <div className="field">
              <label>Hora de Início</label>
              <input type="time" value={horaInicio} onChange={(event) => setHoraInicio(event.target.value)} />
            </div>
            <div className="field">
              <label>Transição entre Jogos (min)</label>
              <input type="number" min="0" max="60" value={transicao} onChange={(event) => setTransicao(Number(event.target.value))} />
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header"><span className="section-label">Duração dos Jogos</span></div>
          <div style={{ padding: '0 24px 20px' }}>
            <div className="field">
              <label>Duração de cada Jogo (minutos)</label>
              <input type="range" min="5" max="180" value={duracao} onChange={(event) => setDuracao(Number(event.target.value))} />
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--navy)' }}><span>{duracao}</span> min</div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span className="section-label" style={{ margin: 0 }}>Campos Disponíveis</span>
              <div className="fields-count">
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Número de campos:</span>
                <input type="number" min="1" max="10" value={numCampos} onChange={(event) => setNumCampos(Number(event.target.value))} style={{ width: 60, padding: '6px 10px', borderRadius: 8, fontSize: 14, fontWeight: 600 }} />
              </div>
            </div>
          </div>
          <div className="fields-list" style={{ padding: '0 24px 20px' }}>
            {campos.map((campo, index) => (
              <div className="field-item" key={index}>
                <label>Campo {index + 1}</label>
                <input type="text" value={campo} onChange={(event) => updateField(index, event.target.value)} />
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-header"><span className="section-label">Ficheiro de Equipas</span></div>
          <div className={`upload-zone${selectedFile ? ' has-file' : ''}`}>
            <input
              type="file"
              accept=".pdf,.csv,.xls,.xlsx,.xlsm,.xlsb,application/pdf,text/csv,application/vnd.ms-excel,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel.sheet.binary.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream"
              onChange={handleFileChange}
            />
            <div className="upload-default">
              <p className="upload-title">Arraste ou clique para carregar</p>
              <p className="upload-sub">Formatos aceites: <span>PDF, Excel (.xls/.xlsx), CSV</span>.</p>
            </div>
            <div className="file-info">
              <div className="file-dot"></div>
              <span>{fileName}</span>
            </div>
          </div>

          <div className="card-header"><span className="section-label">Notas e Instruções Adicionais</span></div>
          <div style={{ padding: '0 24px 20px' }}>
            <div className="field">
              <textarea
                id="notes-input"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Exemplo: Quero que a Equipa X jogue no Campo 3; Equipa X joga às 10:30; Equipa no Grupo B"
              />
            </div>
          </div>

          

          {error ? <div className="error-box visible" role="alert">{error}</div> : <div className="error-box" />}
          {successMessage ? <div className="success-box visible" role="status">{successMessage}</div> : <div className="success-box" />}
          {lastResponseDebug && (
            <div style={{ padding: '12px 24px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Debug: resposta do n8n</div>
              <pre style={{ maxHeight: 280, overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', padding: 12, borderRadius: 8, fontSize: 12 }}>{JSON.stringify(lastResponseDebug, null, 2)}</pre>
            </div>
          )}

          <div className="submit-wrap">
            <button className="submit-btn" onClick={submitWorkflow} disabled={loading}>
              <span>{loading ? 'A processar fluxo...' : activeWorkflow.label.toUpperCase()}</span>
            </button>
          </div>
        </section>

        {workflowResponse && !resultMatches.length && (
          <section className="card">
            <div className="results-header">
              <div className="results-title">{activeWorkflow.label}</div>
              <div className="results-meta">Resposta do n8n</div>
            </div>
            <div className="workflow-response">
              <pre>{JSON.stringify(workflowResponse, null, 2)}</pre>
            </div>
          </section>
        )}

        <div className="divider" style={{ display: resultMatches.length ? 'flex' : 'none' }}>Resultado do Sorteio</div>

        {resultMatches.length > 0 && (
          <section className="card">
            <div className="results-header">
              <div className="results-title">{selectedFormatConfig.label} — Sorteio #{drawCounter}</div>
              <div className="results-meta">{resultMatches.length} jogos · {phases.length} fases</div>
            </div>

            <div className="export-bar">
              <button className="export-btn" onClick={() => exportCSV(resultMatches)}>Exportar CSV</button>
              <button className="export-btn" onClick={() => exportExcel(resultMatches)}>Exportar Excel</button>
              <button className="export-btn" onClick={() => exportPDF(resultMatches)}>Exportar PDF</button>
            </div>

            {phases.length > 0 && activePhase && (
              <div className="phase-showcase">
                <div className="phase-squares-wrap">
                  {phases.map((phaseItem, index) => {
                    const isGroup = /grupo/i.test(phaseItem.phase)
                    return (
                      <button
                        key={phaseItem.phase}
                        type="button"
                        className={`phase-square${index === selectedPhaseIndex ? ' active' : ''}`}
                        onClick={() => setSelectedPhaseIndex(index)}
                      >
                        <span className="phase-square-label">{getPhaseDisplayLabel(phaseItem.phase)}</span>
                        <small>{phaseItem.matches.length} jogos</small>
                        <em>{isGroup ? 'Grupo' : 'Fase'}</em>
                      </button>
                    )
                  })}
                </div>

                <div className="phase-detail-card">
                  <div className="phase-header">
                    <div className="phase-title-wrap">
                      <div className={`phase-dot${isKO(activePhase.phase) ? ' knockout' : ''}`}></div>
                      <span className="phase-title">{getPhaseDisplayLabel(activePhase.phase)}</span>
                      {isKO(activePhase.phase) ? null : <span className="phase-group-badge">{getGroupLabel(activePhase.phase)}</span>}
                      <span className="phase-count">{activePhase.matches.length}</span>
                    </div>
                  </div>

                  <div className="phase-matches">
                    <div className="group-squares-wrap">
                      <div className="group-squares-heading">
                        <span>Equipas</span>
                        <strong>{getPhaseDisplayLabel(activePhase.phase)}</strong>
                      </div>
                      <div className="group-squares-grid">
                        {[...new Set(activePhase.matches.flatMap((match) => [match.homeTeam, match.awayTeam]))].sort().map((team) => (
                          <button
                            type="button"
                            key={team}
                            className={`group-square-card${selectedGroupTeam === team ? ' active' : ''}`}
                            onClick={() => setSelectedGroupTeam(team)}
                          >
                            <div className="group-square-name">{team}</div>
                          </button>
                        ))}
                      </div>
                      <div className="group-squares-hint">
                        {selectedGroupTeam ? `Equipa selecionada: ${selectedGroupTeam}` : 'Clique numa equipa para a destaçar.'}
                      </div>
                    </div>

                    <div className="matches-head">
                      <div style={{ textAlign: 'center' }}>Data</div>
                      <div style={{ textAlign: 'center' }}>Campo</div>
                      <div style={{ textAlign: 'right' }}>Casa</div>
                      <div style={{ textAlign: 'center' }}>—</div>
                      <div>Fora</div>
                      <div style={{ textAlign: 'right' }}>Duração</div>
                      <div style={{ textAlign: 'right' }}>Estado</div>
                    </div>
                    {activePhase.matches.map((match) => (
                      <div className="match-row" key={match.id}>
                        <div className="col-date">
                          <div className="match-date">{formatDate(match.date)}</div>
                          <div className="match-time">{match.time || '—'}</div>
                        </div>
                        <div className="col-field"><span className="field-badge">{match.venue || '—'}</span></div>
                        <div className="col-home"><span className="team-name">{match.homeTeam}</span></div>
                        <div className="col-score"><div className="score-box">VS</div></div>
                        <div className="col-away"><span className="team-name">{match.awayTeam}</span></div>
                        <div className="col-dur">{match.duration ? `${match.duration}min` : '—'}</div>
                        <div className="col-status"><span className="status-badge">Agendado</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="results-footer">Dragon Force · Sorteio #{drawCounter} · {resultMatches.length} jogos · {new Date().toLocaleDateString('pt-PT')}</div>
          </section>
        )}
      </div>
    </div>
  )
}

function exportCSV(matches = []) {
  const headers = ['Fase', 'Data', 'Hora', 'Campo', 'Casa', 'Hora Casa', 'Fora', 'Hora Fora', 'Duração', 'Estado']
  const rows = matches.map((match) => [match.phase, match.date, match.time, match.venue, match.homeTeam, match.homeTime || match.home_time || match.time || '', match.awayTeam, match.awayTime || match.away_time || match.time || '', match.duration ? `${match.duration}min` : '', match.status])
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  downloadFile('sorteio_dragonforce.csv', blob)
}

function exportExcel(matches = []) {
  const headers = ['Fase', 'Data', 'Hora', 'Campo', 'Casa', 'Hora Casa', 'Fora', 'Hora Fora', 'Duração', 'Estado']
  const rows = matches.map((match) => [match.phase, match.date, match.time, match.venue, match.homeTeam, match.homeTime || match.home_time || match.time || '', match.awayTeam, match.awayTime || match.away_time || match.time || '', match.duration ? `${match.duration}min` : '', match.status])
  const tsv = [headers, ...rows].map((row) => row.map((cell) => String(cell || '')).join('\t')).join('\n')
  const blob = new Blob(['\uFEFF' + tsv], { type: 'application/vnd.ms-excel;charset=utf-8;' })
  downloadFile('sorteio_dragonforce.xls', blob)
}

function exportPDF(matches = []) {
  const byPhase = {}
  matches.forEach((match) => {
    if (!byPhase[match.phase]) byPhase[match.phase] = []
    byPhase[match.phase].push(match)
  })

  const phases = Object.keys(byPhase).sort((a, b) => phaseOrder(a) - phaseOrder(b))
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sorteio Dragon Force</title><style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#04194a;padding:20px}
    h1{font-size:20px;margin-bottom:4px}
    h2{font-size:13px;margin:16px 0 6px;padding:6px 10px;background:#e8eeff;border-left:4px solid #0040c8}
    table{width:100%;border-collapse:collapse;margin-bottom:12px}
    th{background:#04194a;color:white;padding:6px 8px;text-align:left;font-size:10px}
    td{padding:5px 8px;border-bottom:1px solid #e8eef8;font-size:11px}
    tr:nth-child(even)td{background:#f5f6fa}
    .footer{margin-top:20px;font-size:10px;color:#6b7a99;text-align:right}
  </style></head><body>
    <h1>Dragon Force — Sorteio</h1>
    <p style="color:#6b7a99;font-size:11px">${matches.length} jogos · ${new Date().toLocaleDateString('pt-PT')}</p>`

  phases.forEach((phase) => {
    html += `<h2>${phase}</h2><table><thead><tr><th>Data</th><th>Hora</th><th>Campo</th><th>Casa</th><th>Hora Casa</th><th>Fora</th><th>Hora Fora</th><th>Duração</th></tr></thead><tbody>`
    byPhase[phase].forEach((match) => {
      html += `<tr><td>${match.date || '—'}</td><td>${match.time || '—'}</td><td>${match.venue || '—'}</td><td>${match.homeTeam}</td><td>${match.homeTime || match.home_time || match.time || '—'}</td><td>${match.awayTeam}</td><td>${match.awayTime || match.away_time || match.time || '—'}</td><td>${match.duration ? `${match.duration}min` : '—'}</td></tr>`
    })
    html += `</tbody></table>`
  })

  html += `<div class="footer">FC Porto · Dragon Force · Gerado automaticamente</div></body></html>`

  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
  setTimeout(() => win.print(), 500)
}

function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
