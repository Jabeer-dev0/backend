// Converts Mongoose-style filters/sorts/projections into SQL fragments for D1.

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

function isObjectId(v) {
  return v && typeof v === 'object' && (v._bsontype === 'ObjectId' || (v.toHexString && v.id && typeof v.id === 'function'))
}

function needsBareDate(v) {
  return v instanceof Date
}

function needsBareId(v) {
  return isObjectId(v)
}

// Normalize a filter value into a SQL parameter placeholder-safe primitive.
function sqlValue(v, colType = '') {
  if (v === undefined) return null
  if (v === null) return null
  if (v instanceof Date) return v.toISOString()
  if (isObjectId(v)) return String(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v)) return JSON.stringify(v)
  if (isObject(v)) return JSON.stringify(v)
  return v
}

const OPERATOR_SQL = {
  $eq: '=',
  $ne: '<>',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
}

// Build "WHERE ..." (without leading WHERE) + params from a filter object.
// cols: map of field name -> column type ('int' | 'real' | 'text' | 'json' | 'bool' | 'date' | 'id' | null)
export function buildWhere(filter = {}, cols = {}, tableAlias = '') {
  const clauses = []
  const params = []
  const col = (field) => (tableAlias ? `${tableAlias}.${field}` : field)
  const P = (v) => {
    params.push(v)
    return '?'
  }

  // Dotted paths (e.g. "subscription.tier", "weeklySchedule.enabled") are
  // JSON object/array columns in D1 — translate them to json_extract().
  const colExprFor = (field) => {
    const dot = field.indexOf('.')
    if (dot > 0) {
      const parent = field.slice(0, dot)
      const child = field.slice(dot + 1)
      const pcol = cols[parent]
      if (pcol && (pcol.type === 'object' || pcol.type === 'array')) {
        return `json_extract(${col(parent)}, '$.${child}')`
      }
    }
    return col(field)
  }

  for (const [key, cond] of Object.entries(filter)) {
    if (cond === undefined) continue
    const field = key === '_id' ? 'id' : key
    const ce = colExprFor(field)

    if (key === '$or' && Array.isArray(cond)) {
      const ors = cond.map((sub) => {
        const r = buildWhere(sub, cols, tableAlias)
        params.push(...r.params)
        return `(${r.clause})`
      })
      if (ors.length) clauses.push(`(${ors.join(' OR ')})`)
      continue
    }

    if (key === '$and' && Array.isArray(cond)) {
      const ands = cond.map((sub) => {
        const r = buildWhere(sub, cols, tableAlias)
        params.push(...r.params)
        return `(${r.clause})`
      })
      if (ands.length) clauses.push(`(${ands.join(' AND ')})`)
      continue
    }

    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      clauses.push(`${ce} = ${P(sqlValue(cond))}`)
      continue
    }

    if (needsBareDate(cond)) {
      clauses.push(`${ce} = ${P(sqlValue(cond))}`)
      continue
    }

    if (needsBareId(cond)) {
      clauses.push(`${ce} = ${P(sqlValue(cond))}`)
      continue
    }

    const hasOp = Object.keys(cond).some((k) => k.startsWith('$'))
    if (!hasOp) {
      // { field: { nested: ... } } — treat as JSON equality fallback
      clauses.push(`${ce} = ${P(sqlValue(cond))}`)
      continue
    }

    for (const [op, v] of Object.entries(cond)) {
      if (v === undefined) continue
      switch (op) {
        case '$eq':
          clauses.push(`${ce} = ${P(sqlValue(v))}`)
          break
        case '$ne':
          if (v === null || v === undefined) {
            clauses.push(`${ce} IS NOT NULL`)
          } else {
            clauses.push(`(${ce} IS NULL OR ${ce} <> ${P(sqlValue(v))})`)
          }
          break
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          clauses.push(`${ce} ${OPERATOR_SQL[op]} ${P(sqlValue(v))}`)
          break
        case '$in': {
          const arr = Array.isArray(v) ? v : []
          if (!arr.length) {
            clauses.push('0 = 1')
            break
          }
          // Mongo: null inside $in matches missing/null values. SQLite IN(...)
          // never matches NULL, so pull nulls out into an explicit IS NULL.
          const hasNull = arr.some((x) => x === null || x === undefined)
          const realVals = arr.filter((x) => x !== null && x !== undefined)
          const groups = []
          for (let i = 0; i < realVals.length; i += 90) {
            const chunk = realVals.slice(i, i + 90)
            groups.push(`${ce} IN (${chunk.map((x) => P(sqlValue(x))).join(', ')})`)
          }
          if (hasNull) {
            clauses.push(`(${ce} IS NULL${groups.length ? ` OR (${groups.join(' OR ')})` : ''})`)
          } else {
            clauses.push(`(${groups.join(' OR ')})`)
          }
          break
        }
        case '$contains':
          clauses.push(`EXISTS (SELECT 1 FROM json_each(${ce}) WHERE value = ${P(sqlValue(v))})`)
          break
        case '$nin': {
          const arr = Array.isArray(v) ? v : []
          if (!arr.length) {
            clauses.push('1 = 1')
            break
          }
          // Mongo: $nin with null matches ONLY present/non-null values that are
          // not in the list (i.e. null/missing are EXCLUDED). SQLite NOT IN(...)
          // already drops NULLs, so when null is in the list we must also force
          // IS NOT NULL; otherwise (no null) keep the original null-included form.
          const hasNull = arr.some((x) => x === null || x === undefined)
          const realVals = arr.filter((x) => x !== null && x !== undefined)
          const groups = []
          for (let i = 0; i < realVals.length; i += 90) {
            const chunk = realVals.slice(i, i + 90)
            groups.push(`${ce} NOT IN (${chunk.map((x) => P(sqlValue(x))).join(', ')})`)
          }
          if (hasNull) {
            clauses.push(`(${ce} IS NOT NULL${groups.length ? ` AND (${groups.join(' AND ')})` : ''})`)
          } else {
            clauses.push(`(${ce} IS NULL OR (${groups.join(' AND ')}))`)
          }
          break
        }
        case '$exists':
          clauses.push(v ? `${ce} IS NOT NULL AND ${ce} <> ''` : `(${ce} IS NULL OR ${ce} = '')`)
          break
        case '$regex': {
          // Convert MongoDB regex to SQL search. Uses INSTR() for case-insensitive
          // to avoid SQLite's SQLITE_MAX_LIKE_PATTERN_LENGTH (50 char) limit.
          const options = cond.$options || ''
          let src = String(v)
          const like = src
            .replace(/\\[.*+?^${}()|[\]\\]/g, (m) => (m === '\\' ? '\\\\' : ''))
            .replace(/\*/g, '%')
          if (options.includes('i')) {
            clauses.push(`INSTR(lower(${ce}), lower(${P(like)})) > 0`)
          } else {
            clauses.push(`INSTR(${ce}, ${P(like)}) > 0`)
          }
          break
        }
        case '$not':
        case '$options':
          break
        default:
          break
      }
    }
  }

  return { clause: clauses.join(' AND '), params }
}

// Build ORDER BY from a sort object like { createdAt: -1, title: 1 }
export function buildOrderBy(sort = {}) {
  const parts = Object.entries(sort).map(([field, dir]) => {
    const col = field === '_id' ? 'id' : field
    const d = dir < 0 ? 'DESC' : 'ASC'
    return `${col} ${d}`
  })
  return parts.length ? `ORDER BY ${parts.join(', ')}` : ''
}

// Build column projection from select spec (string 'a b c' or object {a:1,b:0})
export function buildProjection(tableCols, select) {
  if (!select) return null
  const pick = new Set()
  if (typeof select === 'string') {
    select.split(/\s+/).filter(Boolean).forEach((f) => pick.add(f))
  } else if (isObject(select)) {
    for (const [f, v] of Object.entries(select)) {
      if (v === 1 || v === true) pick.add(f)
      else if (v === 0 || v === false) pick.delete(f)
    }
  }
  if (!pick.size) return null
  const available = new Set(['id', ...tableCols])
  const fields = [...pick].filter((f) => available.has(f))
  return fields.length ? fields.join(', ') : null
}

// The D1 HTTP API caps bound parameters per statement (100). When a filter has
// an $in/$nin array larger than `max`, split it into several sub-filters, each
// with a bounded array. Returns a list of sub-filters (or null if no split is
// needed). Recursively splits $or branches and multiple large arrays.
export function splitInFilter(filter = {}, max = 60) {
  function findLarge(obj) {
    if (!obj || typeof obj !== 'object') return null
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$or' && Array.isArray(v)) {
        for (const sub of v) {
          const r = findLarge(sub)
          if (r) return r
        }
        continue
      }
      if (k === '$and' && Array.isArray(v)) {
        for (const sub of v) {
          const r = findLarge(sub)
          if (r) return r
        }
        continue
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$in) && v.$in.length > max) {
        return { obj, key: k, cond: v }
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.$nin) && v.$nin.length > max) {
        return { obj, key: k, cond: v }
      }
    }
    return null
  }

  const found = findLarge(filter)
  if (!found) return null

  const { obj, key, cond } = found
  const arr = Array.isArray(cond.$in) ? cond.$in : cond.$nin
  const isNin = !Array.isArray(cond.$in)
  const subs = []

  for (let i = 0; i < arr.length; i += max) {
    const sub = JSON.parse(JSON.stringify(filter))
    const target = isNin ? { ...cond, $nin: arr.slice(i, i + max) } : { ...cond, $in: arr.slice(i, i + max) }
    sub[key] = target
    const nested = splitInFilter(sub, max)
    if (nested) subs.push(...nested)
    else subs.push(sub)
  }
  return subs
}
