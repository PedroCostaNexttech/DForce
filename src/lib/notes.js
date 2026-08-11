const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const stripTrailingActionWords = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+(?:joga(?:m)?|jogar|jogou|jogara|jogará|fica(?:m)?|esta(?:m)?|est[aã]o|vai(?:m)?|vai|podem?|pode)\s*$/i, '')
    .trim()

export function parseMaybeJson(value, fallback) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return fallback
}

export function resolveTeamName(rawName, teams) {
  const name = normalize(stripTrailingActionWords(rawName))

  const aliases = {
    benfica: 'SL Benfica',
    porto: 'FC Porto',
    sporting: 'Sporting CP',
    braga: 'SC Braga',
    vitoria: 'Vitória SC',
    'vitoria sc': 'Vitória SC',
    famalicao: 'FC Famalicão',
    'gil vicente': 'Gil Vicente FC',
    moreirense: 'Moreirense FC',
    arouca: 'FC Arouca',
    'rio ave': 'Rio Ave FC',
    estoril: 'Estoril Praia',
    estrela: 'Estrela Amadora',
    'casa pia': 'Casa Pia AC',
    nacional: 'CD Nacional',
    tondela: 'CD Tondela',
    alverca: 'FC Alverca',
    avs: 'AFS (AVS)',
    'santa clara': 'Santa Clara',
  }

  if (aliases[name] && teams.includes(aliases[name])) return aliases[name]

  const exact = teams.find((team) => normalize(team) === name)
  if (exact) return exact

  const partial = teams.find((team) => normalize(team).includes(name) || name.includes(normalize(team)))
  if (partial) return partial

  return String(rawName || '').trim()
}

export function parseNotes(notes, teams) {
  const constraints = {
    apenasFinsDeSemana: false,
    naoPodemJuntos: [],
    jornadas: {},
    todasJornadas: { casa: [], fora: [] },
    ordemNotas: [],
    gruposNotas: [],
    earliestTimes: {},
    restrictions: [],
  }

  function getOrCreateJornada(num) {
    if (!constraints.jornadas[num]) constraints.jornadas[num] = { casa: [], fora: [] }
    return constraints.jornadas[num]
  }

  String(notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const lower = line.toLowerCase()

      if (
        lower.includes('fim de semana') ||
        lower.includes('fins de semana') ||
        lower.includes('sabado') ||
        lower.includes('sábados') ||
        lower.includes('domingo')
      ) {
        constraints.apenasFinsDeSemana = true
      }

      const together = line.match(/(.+?)\s+e\s+(.+?)\s+n[aã]o\s+podem\s+(?:estar\s+no\s+mesmo\s+grupo|jogar\s+juntos)/i)
      if (together) {
        constraints.naoPodemJuntos.push([normalize(together[1]), normalize(together[2])])
      }

      const orderMatch = line.match(/^(?:ordem|order|prioridade|priorizar)\s*:\s*(.+)$/i)
      if (orderMatch) {
        orderMatch[1]
          .split(/[,;]+|\s+e\s+/i)
          .map((part) => part.trim())
          .filter(Boolean)
          .forEach((team) => {
            const resolved = resolveTeamName(team, teams)
            if (!constraints.ordemNotas.includes(resolved)) constraints.ordemNotas.push(resolved)
          })
      }

      const groupMatch1 = line.match(/^grupo\s*([A-Z0-9]+)\s*[:\-]\s*(.+)$/i)
      if (groupMatch1) {
        const group = groupMatch1[1].toUpperCase()
        groupMatch1[2]
          .split(/[,;]+|\s+e\s+/i)
          .map((part) => part.trim())
          .filter(Boolean)
          .forEach((team) => constraints.gruposNotas.push({ team: resolveTeamName(team, teams), group }))
      } else {
        const groupMatch2 = line.match(/^(.+?)\s+joga(?:m)?\s+no\s+grupo\s*([A-Z0-9]+)$/i)
        if (groupMatch2) {
          const group = groupMatch2[2].toUpperCase()
          groupMatch2[1]
            .split(/[,;]+|\s+e\s+/i)
            .map((part) => part.trim())
            .filter(Boolean)
            .forEach((team) => constraints.gruposNotas.push({ team: resolveTeamName(team, teams), group }))
        } else {
          const groupMatch3 = line.match(/^(.+?)(?:\s+joga(?:m)?|\s+jogar|\s+jogou)?\s+no\s+grupo\s*([A-Z0-9]+)$/i)
          if (groupMatch3) {
            constraints.gruposNotas.push({ team: resolveTeamName(groupMatch3[1], teams), group: groupMatch3[2].toUpperCase() })
          }
        }
      }

      const earliest1 = line.match(/(.+?)\s+s[oó]\s+joga a partir das\s+(\d{1,2}:\d{2})/i)
      if (earliest1) constraints.earliestTimes[resolveTeamName(earliest1[1], teams)] = earliest1[2]

      const earliest2 = line.match(/(.+?)\s+s[oó]\s+joga a partir das\s+(\d{1,2})h/i)
      if (earliest2) constraints.earliestTimes[resolveTeamName(earliest2[1], teams)] = `${String(earliest2[2]).padStart(2, '0')}:00`

      const notAway = line.match(/(.+?)\s+(?:nao|não)\s+pode jogar fora na jornada\s*(\d+)/i)
      if (notAway) constraints.restrictions.push({ team: resolveTeamName(notAway[1], teams), type: 'notAway', jornada: String(notAway[2]) })

      const notHome = line.match(/(.+?)\s+(?:nao|não)\s+pode jogar em casa na jornada\s*(\d+)/i)
      if (notHome) constraints.restrictions.push({ team: resolveTeamName(notHome[1], teams), type: 'notHome', jornada: String(notHome[2]) })

      const notGroup = line.match(/(.+?)\s+e\s+(.+?)\s+(?:nao|não)\s+podem estar no mesmo grupo/i)
      if (notGroup) {
        constraints.naoPodemJuntos.push([normalize(notGroup[1]), normalize(notGroup[2])])
      }
    })

  return constraints
}

export function getPreviewPayload(notes, teams) {
  const parsed = parseNotes(notes, teams)
  return {
    ordemNotas: parsed.ordemNotas,
    gruposNotas: parsed.gruposNotas,
    earliestTimes: parsed.earliestTimes,
    restrictions: parsed.restrictions,
  }
}
