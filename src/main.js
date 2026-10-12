import JSZip from 'jszip'
import './style.css'

const $ = (selector) => document.querySelector(selector)
const PAGE_SIZE = 60
const MAX_ARCHIVE_SIZE = 300 * 1024 * 1024
const MAX_LANGUAGE_FILE_SIZE = 24 * 1024 * 1024

const localeNames = {
  en_us: 'English (US)',
  en_gb: 'English (UK)',
  en_au: 'English (Australia)',
  zh_cn: '简体中文',
  zh_tw: '繁體中文',
  ja_jp: '日本語',
  ko_kr: '한국어',
  fr_fr: 'Français',
  fr_ca: 'Français (Canada)',
  de_de: 'Deutsch',
  es_es: 'Español',
  es_mx: 'Español (México)',
  pt_br: 'Português (Brasil)',
  pt_pt: 'Português (Portugal)',
  ru_ru: 'Русский',
  it_it: 'Italiano',
  nl_nl: 'Nederlands',
  pl_pl: 'Polski',
  uk_ua: 'Українська',
  cs_cz: 'Čeština',
  tr_tr: 'Türkçe',
  ar_sa: 'العربية'
}

const sampleSource = {
  'item.forest_expansion.moonberry': 'Moonberry',
  'block.forest_expansion.ancient_log': 'Ancient Log',
  'entity.forest_expansion.mossling': 'Mossling',
  'screen.forest_expansion.research.title': 'Field Notes',
  'screen.forest_expansion.research.empty': 'No notes collected yet.',
  'tooltip.forest_expansion.moonberry.regrow': 'Regrows after sunrise.',
  'message.forest_expansion.ritual.started': 'The ritual will begin in %s seconds.',
  'message.forest_expansion.ritual.complete': 'The forest has answered.',
  'item.forest_expansion.old_compass': 'Old Compass',
  'tooltip.forest_expansion.old_compass.pointing': 'Points toward the nearest ruin.',
  'advancement.forest_expansion.first_grove.title': 'Into the Grove',
  'advancement.forest_expansion.first_grove.description': 'Find a hidden grove.'
}

const sampleTarget = {
  'item.forest_expansion.moonberry': '月光浆果',
  'block.forest_expansion.ancient_log': '古木原木',
  'entity.forest_expansion.mossling': '苔灵',
  'screen.forest_expansion.research.title': '野外手记'
}

const sampleJapanese = {
  'item.forest_expansion.moonberry': 'ムーンベリー',
  'block.forest_expansion.ancient_log': '古代の原木',
  'entity.forest_expansion.mossling': 'モスリング',
  'screen.forest_expansion.research.title': 'フィールドノート',
  'screen.forest_expansion.research.empty': 'まだ記録はありません。',
  'tooltip.forest_expansion.moonberry.regrow': '日の出後に再び実ります。'
}

const state = {
  zip: null,
  fileName: '',
  fileInfo: '',
  langFiles: [],
  fileErrors: [],
  entries: [],
  entryMap: new Map(),
  sourceLocale: 'en_us',
  targetLocale: 'zh_cn',
  drafts: new Map(),
  dirtyByLocale: new Map(),
  exportedLocales: new Set(),
  exportHistory: [],
  selected: new Set(),
  filter: 'all',
  query: '',
  page: 1,
  visibleEntries: [],
  stats: { total: 0, translated: 0, pending: 0, issues: 0, namespaces: 0 },
  isDemo: false,
  busy: false
}

const icons = {
  success: '<svg viewBox="0 0 18 18"><path d="m3.5 9 3.3 3.3 7.7-7.7"/></svg>',
  error: '<svg viewBox="0 0 18 18"><path d="M9 3.2 16 15H2z"/><path d="M9 7v3.4M9 12.7h.01"/></svg>',
  file: '<svg viewBox="0 0 18 18"><path d="M4 2.8h6l4 4v8.4H4z"/><path d="M10 2.8v4h4"/></svg>'
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char])
}

function getLocaleName(locale) {
  return localeNames[locale] || locale.replace('_', '-').replace(/(^|-)\w/g, (part) => part.toUpperCase())
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function draftKey(locale, group, key) {
  return `${locale}\u0000${group}\u0000${key}`
}

function entryId(group, key) {
  return `${group}\u0000${key}`
}

function namespaceFromGroup(group) {
  const parts = group.split('/')
  const assetsAt = parts.lastIndexOf('assets')
  if (assetsAt >= 0 && parts[assetsAt + 1]) return parts[assetsAt + 1]
  return parts.filter((part) => part && part !== 'lang').at(-1) || group
}

function placeholders(text) {
  const matches = String(text || '').match(/%%|%(?:\d+\$)?[-+0#]*\d*(?:\.\d+)?[a-zA-Z]|%\([^)]+\)[a-zA-Z]|\{[a-zA-Z0-9_.-]+\}|\$\{[^}]+\}/g) || []
  // %% 是转义的百分号；%1$s 和 %s 当成同一个参数，允许译文调换顺序
  return matches
    .filter((item) => item !== '%%')
    .map((item) => item.replace(/^%\d+\$/, '%'))
    .sort()
}

function hasPlaceholderIssue(entry) {
  if (!entry.target || !entry.target.trim()) return false
  const left = placeholders(entry.source).join('\u0001')
  const right = placeholders(entry.target).join('\u0001')
  return left !== right
}

function getEntryStatus(entry) {
  if (!entry.target || !entry.target.trim()) return 'pending'
  if (hasPlaceholderIssue(entry)) return 'issue'
  return 'done'
}

function makeLangFile(path, raw, rawText = '') {
  const match = path.match(/(?:^|\/)lang\/([^/]+)\.(json|lang)$/i)
  if (!match) return null
  const format = match[2].toLowerCase()
  const locale = match[1].toLowerCase()
  const group = path.slice(0, path.lastIndexOf('/'))
  const data = new Map()

  if (format === 'json') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('语言 JSON 顶层需要是对象')
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') data.set(key, value)
    }
  } else {
    const lines = String(rawText).split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
      const sep = line.indexOf('=')
      if (sep < 0) continue
      const key = line.slice(0, sep).trim()
      if (key) data.set(key, line.slice(sep + 1).trim())
    }
  }

  return { path, locale, group, namespace: namespaceFromGroup(group), format, raw, rawText, data }
}

function parseLanguageText(path, text) {
  // JSZip 读出来的字符串会保留 BOM，Windows 编辑器存的文件会因此 JSON.parse 失败
  text = text.replace(/^\uFEFF/, '')
  const format = path.toLowerCase().endsWith('.lang') ? 'lang' : 'json'
  const raw = format === 'json' ? JSON.parse(text) : null
  return makeLangFile(path, raw, text)
}

function bootSample() {
  const zip = new JSZip()
  zip.file('fabric.mod.json', JSON.stringify({
    schemaVersion: 1,
    id: 'forest_expansion',
    version: '1.4.2',
    name: 'Forest Expansion',
    depends: { fabricloader: '>=0.15.0', minecraft: '~1.20.1' }
  }, null, 2))
  zip.file('assets/forest_expansion/lang/en_us.json', JSON.stringify(sampleSource, null, 2))
  zip.file('assets/forest_expansion/lang/zh_cn.json', JSON.stringify(sampleTarget, null, 2))
  zip.file('assets/forest_expansion/lang/ja_jp.json', JSON.stringify(sampleJapanese, null, 2))

  state.zip = zip
  state.fileName = 'forest-expansion-1.4.2.jar'
  state.fileInfo = 'Fabric · Minecraft 1.20.1'
  state.langFiles = [
    makeLangFile('assets/forest_expansion/lang/en_us.json', sampleSource),
    makeLangFile('assets/forest_expansion/lang/zh_cn.json', sampleTarget),
    makeLangFile('assets/forest_expansion/lang/ja_jp.json', sampleJapanese)
  ]
  state.isDemo = true
  state.sourceLocale = 'en_us'
  state.targetLocale = 'zh_cn'
  renderLanguageControls()
  rebuildEntries()
  renderAll()
}

function renderLanguageControls() {
  const sourceSelect = $('#source-language')
  const locales = [...new Set(state.langFiles.map((file) => file.locale))].sort((a, b) => {
    if (a === 'en_us') return -1
    if (b === 'en_us') return 1
    return a.localeCompare(b)
  })
  const sourceOptions = locales.length ? locales : ['en_us']
  sourceSelect.innerHTML = sourceOptions.map((locale) => `<option value="${esc(locale)}">${esc(getLocaleName(locale))} · ${esc(locale)}</option>`).join('')
  sourceSelect.value = sourceOptions.includes(state.sourceLocale) ? state.sourceLocale : sourceOptions[0]
  sourceSelect.disabled = !state.langFiles.length

  const suggestions = [...new Set([...locales, ...Object.keys(localeNames)])].sort((a, b) => {
    if (a === 'zh_cn') return -1
    if (b === 'zh_cn') return 1
    if (a === 'en_us') return -1
    if (b === 'en_us') return 1
    return a.localeCompare(b)
  })
  $('#language-options').innerHTML = suggestions.map((locale) => `<option value="${esc(locale)}" label="${esc(getLocaleName(locale))}"></option>`).join('')
  $('#target-language').value = state.targetLocale
  updateLanguageLabels()
}

function updateLanguageLabels() {
  const source = state.sourceLocale
  const target = state.targetLocale
  $('#source-label').textContent = getLocaleName(source)
  $('#target-label').textContent = `${getLocaleName(target)} · ${target}`
  $('#project-more').title = `下载 ${target} 语言文件`
}

function rebuildEntries() {
  const groups = new Set()
  const sourceFiles = state.langFiles.filter((file) => file.locale === state.sourceLocale)
  const targetFiles = state.langFiles.filter((file) => file.locale === state.targetLocale)
  for (const file of sourceFiles) groups.add(file.group)
  for (const file of targetFiles) groups.add(file.group)

  const entries = []
  for (const group of groups) {
    const sourceFile = sourceFiles.find((file) => file.group === group)
    const targetFile = targetFiles.find((file) => file.group === group)
    const keys = new Set([...(sourceFile?.data.keys() || []), ...(targetFile?.data.keys() || [])])
    for (const key of keys) {
      const id = entryId(group, key)
      const saved = state.drafts.get(draftKey(state.targetLocale, group, key))
      entries.push({
        id,
        key,
        group,
        namespace: sourceFile?.namespace || targetFile?.namespace || namespaceFromGroup(group),
        source: sourceFile?.data.get(key) ?? '',
        target: saved ?? targetFile?.data.get(key) ?? ''
      })
    }
  }

  state.entries = entries
  state.entryMap = new Map(entries.map((entry) => [entry.id, entry]))
  state.selected.clear()
  recalcStats()
}

function recalcStats() {
  let translated = 0
  let issues = 0
  const groups = new Set()
  for (const entry of state.entries) {
    groups.add(entry.group)
    if (entry.target && entry.target.trim()) {
      translated++
      if (hasPlaceholderIssue(entry)) issues++
    }
  }
  state.stats = {
    total: state.entries.length,
    translated,
    pending: state.entries.length - translated,
    issues,
    namespaces: groups.size
  }
}

function markDirty(entry) {
  let changed = state.dirtyByLocale.get(state.targetLocale)
  if (!changed) {
    changed = new Set()
    state.dirtyByLocale.set(state.targetLocale, changed)
  }
  changed.add(entry.id)
}

function setEntryTarget(entry, value) {
  const next = String(value ?? '')
  if (entry.target === next) return false

  const wasDone = Boolean(entry.target && entry.target.trim())
  const hadIssue = wasDone && hasPlaceholderIssue(entry)
  const willBeDone = Boolean(next && next.trim())
  entry.target = next
  const hasIssue = willBeDone && hasPlaceholderIssue(entry)

  if (wasDone !== willBeDone) {
    state.stats.translated += willBeDone ? 1 : -1
    state.stats.pending = state.stats.total - state.stats.translated
  }
  if (hadIssue !== hasIssue) state.stats.issues += hasIssue ? 1 : -1

  state.drafts.set(draftKey(state.targetLocale, entry.group, entry.key), next)
  markDirty(entry)
  return true
}

function updateStatsUI() {
  const { total, translated, pending, issues, namespaces } = state.stats
  const rate = total ? Math.round((translated / total) * 100) : 0
  $('#stat-total').textContent = total
  $('#stat-done').textContent = translated
  $('#stat-pending').textContent = pending
  $('#stat-rate').textContent = `${rate}%`
  $('#stat-issues').textContent = issues
  $('#stat-total-foot').textContent = `来自 ${namespaces} 个命名空间`
  $('#stat-issues-foot').textContent = issues ? '请核对译文格式' : '格式正常'
  $('#filter-all').textContent = total
  $('#filter-pending').textContent = pending
  $('#filter-done').textContent = translated
  $('#filter-issues').textContent = issues
  $('#progress-percent').innerHTML = `${rate}<span>%</span>`
  $('#progress-caption').textContent = `${translated} / ${total} 已完成`
  $('#progress-fill').style.width = `${rate}%`
  $('#progress-done').textContent = translated
  $('#progress-pending').textContent = pending
  $('#quality-count').textContent = issues
  $('#quality-count').classList.toggle('has-issues', issues > 0)
  $('#placeholder-summary').textContent = issues ? `${issues} 项占位符与原文不一致` : '原文与译文格式一致'
  $('#placeholder-status').classList.toggle('warn', issues > 0)
  $('#placeholder-status').innerHTML = issues
    ? '<svg viewBox="0 0 16 16"><path d="M8 3 14 13H2z"/><path d="M8 6v3M8 11h.01"/></svg>'
    : '<svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6"/></svg>'
  $('#empty-summary').textContent = pending ? `还有 ${pending} 项未填写` : '所有词条都已填写'
  $('#project-entry-count').textContent = `${total} 个词条`
  $('#nav-file-count').textContent = state.langFiles.length
  $('#project-language-count').textContent = `${state.langFiles.length} 个语言文件`
  $('#files-total').textContent = state.langFiles.length
  $('#pack-mod').disabled = state.busy || !state.zip || !state.entries.length
  updateSaveState()
}

function updateProjectInfo() {
  $('#project-name').textContent = state.fileName || '尚未打开 Mod'
  $('#side-project-name').textContent = state.fileName || '尚未打开 Mod'
  $('#side-project-status').textContent = state.isDemo ? '示例项目' : `${state.langFiles.length} 个语言文件`
  $('#project-size').textContent = state.fileInfo || '等待选择 JAR 或 ZIP 文件'
  $('#demo-tag').hidden = !state.isDemo
  $('#project-entry-count').textContent = `${state.entries.length} 个词条`
  $('#project-language-count').textContent = `${state.langFiles.length} 个语言文件`
  $('#nav-file-count').textContent = state.langFiles.length
  $('#files-total').textContent = state.langFiles.length
  updateSaveState()
}

function updateSaveState() {
  const save = $('#save-state')
  const changed = state.dirtyByLocale.get(state.targetLocale)
  const hasOtherChanges = [...state.dirtyByLocale.entries()].some(([locale, ids]) => locale !== state.targetLocale && ids.size)
  save.classList.toggle('is-dirty', Boolean(changed?.size))
  if (changed?.size) {
    save.innerHTML = `<i></i><span>${changed.size} 项待打包</span>`
    $('#project-health-title').textContent = '有未打包修改'
    $('#project-health-sub').textContent = `${state.targetLocale} · ${changed.size} 项待写入`
  } else if (state.exportedLocales.has(state.targetLocale)) {
    save.innerHTML = '<i></i><span>已打包</span>'
    $('#project-health-title').textContent = 'Mod 已打包'
    $('#project-health-sub').textContent = `已写入 ${state.targetLocale}`
  } else if (hasOtherChanges) {
    save.innerHTML = '<i></i><span>其他语言待打包</span>'
    $('#project-health-title').textContent = '文件已就绪'
    $('#project-health-sub').textContent = '其他目标语言有未打包修改'
  } else {
    save.innerHTML = '<i></i><span>未修改</span>'
    $('#project-health-title').textContent = state.langFiles.length ? '文件已就绪' : '未找到语言文件'
    $('#project-health-sub').textContent = state.langFiles.length ? '等待导出' : '可查看原始文件结构'
  }
}

function renderFileList() {
  const container = $('#file-list')
  if (!state.langFiles.length) {
    container.innerHTML = '<div class="file-empty">还没有识别到语言文件</div>'
    return
  }

  const targetFile = state.langFiles.find((file) => file.locale === state.targetLocale)
  const sourceFile = state.langFiles.find((file) => file.locale === state.sourceLocale)
  const prioritized = [targetFile, sourceFile, ...state.langFiles].filter(Boolean)
  const files = [...new Map(prioritized.map((file) => [file.path, file])).values()].slice(0, 3)
  const targetExists = Boolean(targetFile)
  let html = files.map((file) => {
    const isTarget = file.locale === state.targetLocale
    const pathParts = file.path.split('/')
    return `<div class="language-file">
      <span class="lang-file-icon ${isTarget ? 'lang-file-current' : ''}">${isTarget ? '<svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6"/></svg>' : icons.file}</span>
      <span class="lang-file-name"><strong>${esc(file.locale)}</strong><small title="${esc(file.path)}">${esc(pathParts.slice(0, -1).join('/'))}/${esc(pathParts.at(-1))}</small></span>
      <span class="lang-file-count">${file.data.size} 条</span>
    </div>`
  }).join('')

  if (!targetExists && state.langFiles.length < 4) {
    const sourceFile = state.langFiles.find((file) => file.locale === state.sourceLocale)
    const path = sourceFile ? `${sourceFile.group}/${state.targetLocale}.${sourceFile.format}` : `${state.targetLocale}.json`
    html += `<div class="language-file">
      <span class="lang-file-icon"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></span>
      <span class="lang-file-name"><strong>${esc(state.targetLocale)}</strong><small title="${esc(path)}">打包时将新建文件</small></span>
      <span class="lang-file-count">待创建</span>
    </div>`
  }
  if (state.langFiles.length > 3) {
    html += `<div class="file-more">另有 ${state.langFiles.length - 3} 个语言文件，查看完整路径</div>`
  }
  container.innerHTML = html
}

function getFilteredEntries() {
  const query = state.query.trim().toLocaleLowerCase()
  return state.entries.filter((entry) => {
    if (state.filter === 'pending' && entry.target.trim()) return false
    if (state.filter === 'done' && !entry.target.trim()) return false
    if (state.filter === 'issues' && !hasPlaceholderIssue(entry)) return false
    if (!query) return true
    return `${entry.key}\n${entry.source}\n${entry.target}\n${entry.namespace}`.toLocaleLowerCase().includes(query)
  })
}

function renderRows() {
  const filtered = getFilteredEntries()
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  state.page = Math.min(state.page, pageCount)
  const start = (state.page - 1) * PAGE_SIZE
  const visible = filtered.slice(start, start + PAGE_SIZE)
  state.visibleEntries = visible
  const list = $('#entry-list')
  const empty = $('#empty-state')
  list.innerHTML = ''
  empty.hidden = visible.length > 0

  if (!visible.length) {
    if (!state.langFiles.length) {
      $('#empty-title').textContent = '这个 Mod 没有找到可编辑的语言文件'
      $('#empty-copy').textContent = '支持 assets/<命名空间>/lang 下的 .json 和 .lang 文件。'
      $('#empty-clear').hidden = true
    } else {
      $('#empty-title').textContent = state.query || state.filter !== 'all' ? '没有找到匹配的词条' : '当前语言文件没有词条'
      $('#empty-copy').textContent = '试试其他关键词，或清除筛选条件。'
      $('#empty-clear').hidden = false
    }
  }

  list.innerHTML = visible.map((entry) => {
    const status = getEntryStatus(entry)
    const statusText = status === 'pending' ? '待翻译' : status === 'issue' ? '需检查' : '已完成'
    const selected = state.selected.has(entry.id)
    const warningClass = status === 'issue' ? 'placeholder-warning' : ''
    return `<div class="entry-row ${selected ? 'selected' : ''}" data-row-id="${esc(encodeURIComponent(entry.id))}">
      <div class="check-cell"><input type="checkbox" data-select-entry data-id="${esc(encodeURIComponent(entry.id))}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(entry.key)}" /></div>
      <div class="entry-key"><strong title="${esc(entry.key)}">${esc(entry.key)}</strong><small title="${esc(entry.group)}">${esc(entry.namespace)}</small></div>
      <div class="entry-source" title="${esc(entry.source)}">${esc(entry.source || '—')}</div>
      <div class="entry-target"><textarea data-target-entry data-id="${esc(encodeURIComponent(entry.id))}" rows="1" aria-label="译文 ${esc(entry.key)}" placeholder="填写译文…">${esc(entry.target)}</textarea></div>
      <div class="row-status ${status === 'done' ? 'done' : status === 'issue' ? 'issue' : 'missing'}" title="${status === 'issue' ? '译文中的占位符与原文不一致' : ''}">${statusText}</div>
    </div>`
  }).join('')

  for (const textarea of list.querySelectorAll('textarea')) {
    textarea.classList.toggle('placeholder-warning', Boolean(state.entryMap.get(decodeURIComponent(textarea.dataset.id)) && hasPlaceholderIssue(state.entryMap.get(decodeURIComponent(textarea.dataset.id)))))
    if (textarea.value.includes('\n')) fitTextarea(textarea)
  }
  $('#visible-count').textContent = filtered.length
  $('#page-summary').textContent = filtered.length
    ? `显示 ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)}，共 ${filtered.length} 项`
    : '显示 0 项'
  $('#page-number').textContent = state.page
  $('#prev-page').disabled = state.page <= 1
  $('#next-page').disabled = state.page >= pageCount
  for (const tab of document.querySelectorAll('.filter-tab')) {
    const active = tab.dataset.filter === state.filter
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  }
  updateSelectionUI()
  syncBusyControls()
}

function fitTextarea(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 64)}px`
}

function updateSelectionUI() {
  const count = state.selected.size
  $('#bulk-bar').hidden = count === 0
  $('#selected-count').textContent = count
  const visible = state.visibleEntries
  const checked = visible.filter((entry) => state.selected.has(entry.id)).length
  const selectAll = $('#select-visible')
  selectAll.checked = visible.length > 0 && checked === visible.length
  selectAll.indeterminate = checked > 0 && checked < visible.length
}

function syncBusyControls() {
  const controls = document.querySelectorAll('#source-language, #target-language, #search, #select-visible, .filter-tab, #prev-page, #next-page, #copy-source-selected, #clear-selected, #clear-selection, #empty-clear, #show-pending, #quality-jump, #file-detail-button, #entry-list textarea, #entry-list input')
  for (const control of controls) control.disabled = state.busy
}

function renderAll() {
  updateProjectInfo()
  updateStatsUI()
  renderFileList()
  renderRows()
}

function setFilter(filter) {
  state.filter = filter
  state.page = 1
  renderRows()
}

function updateRow(entry) {
  const encoded = encodeURIComponent(entry.id)
  const row = [...document.querySelectorAll('[data-row-id]')].find((node) => node.dataset.rowId === encoded)
  if (!row) return
  const status = getEntryStatus(entry)
  const badge = row.querySelector('.row-status')
  badge.classList.toggle('done', status === 'done')
  badge.classList.toggle('issue', status === 'issue')
  badge.classList.toggle('missing', status === 'pending')
  badge.textContent = status === 'pending' ? '待翻译' : status === 'issue' ? '需检查' : '已完成'
  badge.title = status === 'issue' ? '译文中的占位符与原文不一致' : ''
  row.querySelector('textarea').classList.toggle('placeholder-warning', status === 'issue')
  row.classList.toggle('selected', state.selected.has(entry.id))
}

function setBusy(busy, label = '') {
  state.busy = busy
  $('#open-mod').disabled = busy
  $('#import-translation').disabled = busy
  $('#pack-mod').disabled = busy || !state.zip || !state.entries.length
  $('#project-more').disabled = busy || !state.entries.length
  syncBusyControls()
  if (busy) {
    $('#project-health-title').textContent = label || '正在处理文件'
    $('#project-health-sub').textContent = '请保持页面打开'
    $('#pack-mod').innerHTML = '<span class="spinner"></span>正在打包…'
  } else {
    $('#pack-mod').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14v13H5z"/><path d="M8 7V4h8v3M9 11h6M9 14h6"/></svg>打包 Mod'
    updateSaveState()
  }
}

function toast(message, type = 'success') {
  const node = document.createElement('div')
  node.className = `toast ${type === 'error' ? 'error' : ''}`
  node.innerHTML = `<span class="toast-icon">${icons[type === 'error' ? 'error' : 'success']}</span><span>${esc(message)}</span>`
  $('#toast-region').append(node)
  window.setTimeout(() => node.remove(), 3600)
}

function showModal(title, body, kicker = 'MODLINGO') {
  $('#modal-kicker').textContent = kicker
  $('#modal-title').textContent = title
  $('#modal-body').innerHTML = body
  $('#modal-actions').innerHTML = ''
  $('#modal-backdrop').hidden = false
  $('#modal-close').focus()
}

function closeModal() {
  $('#modal-backdrop').hidden = true
}

function showHistory() {
  const history = state.exportHistory
  if (!history.length) {
    showModal('导出记录', '<div class="history-empty"><svg viewBox="0 0 28 28"><path d="M14 4v12m0 0 4-4m-4 4-4-4"/><path d="M5 16v6h18v-6"/></svg><strong>还没有导出记录</strong><span>完成翻译后点击「打包 Mod」，这里会保留本次会话的记录。</span></div>', 'EXPORT HISTORY')
    return
  }
  const body = history.map((item) => `<div class="history-item"><span class="history-icon"><svg viewBox="0 0 18 18"><path d="M4 2.8h6l4 4v8.4H4z"/><path d="M10 2.8v4h4M6.5 11h5M6.5 13.5h5"/></svg></span><div><strong title="${esc(item.name)}">${esc(item.name)}</strong><span>${esc(item.locale)} · ${item.translated} 项已填写 · ${esc(item.time)}</span></div><span class="history-ok">已完成</span></div>`).join('')
  showModal('导出记录', body, 'EXPORT HISTORY')
}

function showFileDetails() {
  const actual = state.langFiles.map((file) => `<div class="modal-path"><svg viewBox="0 0 18 18"><path d="M4 2.8h6l4 4v8.4H4z"/><path d="M10 2.8v4h4"/></svg><span>${esc(file.path)} · ${file.data.size} 条</span></div>`)
  for (const error of state.fileErrors) {
    actual.push(`<div class="modal-path file-error-path"><svg viewBox="0 0 18 18"><path d="M9 3 16 15H2z"/><path d="M9 7v3M9 12h.01"/></svg><span>${esc(error.path)} · ${esc(error.message)}</span></div>`)
  }
  const targetFound = state.langFiles.some((file) => file.locale === state.targetLocale)
  if (!targetFound) {
    const sourceFiles = state.langFiles.filter((file) => file.locale === state.sourceLocale)
    for (const source of sourceFiles) {
      actual.push(`<div class="modal-path new-target-path"><svg viewBox="0 0 18 18"><path d="M9 3v12M3 9h12"/></svg><span>${esc(`${source.group}/${state.targetLocale}.${source.format}`)} · 打包时新建</span></div>`)
    }
  }
  const body = actual.length
    ? `<p class="modal-copy">已扫描到 ${state.langFiles.length} 个可读语言文件，均在浏览器本地解析。</p><div class="modal-list">${actual.join('')}</div>`
    : '<div class="history-empty"><strong>没有可列出的语言文件</strong><span>可以重新打开一个包含 lang 文件夹的 JAR 或 ZIP。</span></div>'
  showModal('语言文件路径', body, 'ARCHIVE CONTENTS')
}

function showHelp() {
  const body = `<p class="modal-copy">常用操作都可以直接用键盘完成。搜索、编辑和打包均在浏览器本地运行。</p><table class="shortcuts"><tbody><tr><td>打开 Mod</td><td><kbd>Ctrl</kbd> + <kbd>O</kbd></td></tr><tr><td>定位到搜索框</td><td><kbd>/</kbd></td></tr><tr><td>跳到下一个待翻译词条</td><td><kbd>Ctrl</kbd> + <kbd>Enter</kbd></td></tr><tr><td>关闭当前弹窗</td><td><kbd>Esc</kbd></td></tr></tbody></table>`
  showModal('快捷键', body, 'KEYBOARD SHORTCUTS')
}

function normalizeLocale(value) {
  return String(value || '').trim().replace(/-/g, '_').toLowerCase()
}

function changeTargetLanguage() {
  const input = $('#target-language')
  const locale = normalizeLocale(input.value)
  if (!/^[a-z]{2,3}_[a-z0-9]{2,4}$/.test(locale)) {
    toast('语言代码格式不正确，例如 zh_cn 或 pt_br。', 'error')
    input.value = state.targetLocale
    return
  }
  if (locale === state.sourceLocale) {
    toast('源语言和目标语言不能相同。', 'error')
    input.value = state.targetLocale
    return
  }
  state.targetLocale = locale
  input.value = locale
  state.page = 1
  renderLanguageControls()
  rebuildEntries()
  renderAll()
}

function onSourceLanguageChange() {
  const locale = $('#source-language').value
  if (locale === state.targetLocale) {
    toast('源语言和目标语言不能相同。', 'error')
    $('#source-language').value = state.sourceLocale
    return
  }
  state.sourceLocale = locale
  state.page = 1
  renderLanguageControls()
  rebuildEntries()
  renderAll()
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function outputPathFor(group, locale, format) {
  return `${group}/${locale}.${format}`
}

function serializeLang(text, updates) {
  const source = String(text || '')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const ended = /\r?\n$/.test(source)
  // 空文件直接 split 会得到一个空行，写出来开头会多一个换行
  const lines = source ? source.split(/\r?\n/) : []
  if (ended) lines.pop()
  const seen = new Set()
  const result = []

  for (const line of lines) {
    const trimmed = line.trim()
    const sep = line.indexOf('=')
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || sep < 0) {
      result.push(line)
      continue
    }
    const key = line.slice(0, sep).trim()
    if (!updates.has(key)) {
      result.push(line)
      continue
    }
    seen.add(key)
    const value = updates.get(key)
    if (value == null || !String(value).trim()) continue
    result.push(`${line.slice(0, sep + 1)}${String(value).replace(/\r?\n/g, '\\n')}`)
  }

  for (const [key, value] of updates) {
    if (seen.has(key) || value == null || !String(value).trim()) continue
    result.push(`${key}=${String(value).replace(/\r?\n/g, '\\n')}`)
  }
  return result.join(newline) + (ended || result.length ? newline : '')
}

function createLocaleOutputs() {
  const byGroup = new Map()
  for (const entry of state.entries) {
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, [])
    byGroup.get(entry.group).push(entry)
  }
  const outputs = []
  for (const [group, entries] of byGroup) {
    const sourceFile = state.langFiles.find((file) => file.group === group && file.locale === state.sourceLocale)
    const targetFile = state.langFiles.find((file) => file.group === group && file.locale === state.targetLocale)
    if (!sourceFile && !targetFile) continue

    const format = targetFile?.format || sourceFile?.format || 'json'
    const path = targetFile?.path || outputPathFor(group, state.targetLocale, format)
    const updates = new Map(entries.map((entry) => [entry.key, entry.target && entry.target.trim() ? entry.target : null]))
    let content

    if (format === 'json') {
      const output = Object.assign(
        Object.create(null),
        targetFile?.raw && typeof targetFile.raw === 'object' && !Array.isArray(targetFile.raw) ? targetFile.raw : {}
      )
      for (const [key, value] of updates) {
        if (value == null) delete output[key]
        else output[key] = value
      }
      content = `${JSON.stringify(output, null, 2)}\n`
    } else {
      content = serializeLang(targetFile?.rawText ?? sourceFile?.rawText ?? '', updates)
    }
    outputs.push({ path, format, content })
  }
  return outputs
}

async function downloadTargetFiles() {
  if (!state.entries.length) {
    toast('当前没有可导出的语言词条。', 'error')
    return
  }
  const outputs = createLocaleOutputs()
  if (!outputs.length) {
    toast('没有找到可写入的语言文件。', 'error')
    return
  }
  const base = state.fileName.replace(/\.(jar|zip)$/i, '') || 'mod'
  if (outputs.length === 1) {
    const file = outputs[0]
    const leaf = file.path.split('/').at(-1)
    downloadBlob(new Blob([file.content], { type: file.format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }), leaf)
  } else {
    const langZip = new JSZip()
    for (const file of outputs) langZip.file(file.path, file.content)
    const blob = await langZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } })
    downloadBlob(blob, `${base}-${state.targetLocale}-lang-files.zip`)
  }
  toast(`已下载 ${state.targetLocale} 语言文件。`)
}

async function packMod() {
  if (!state.zip || !state.entries.length || state.busy) return
  if (state.targetLocale === state.sourceLocale) {
    toast('请先选择不同于源语言的目标语言。', 'error')
    return
  }
  const outputs = createLocaleOutputs()
  if (!outputs.length) {
    toast('没有可写入的语言文件，请先检查 Mod 内容。', 'error')
    return
  }

  setBusy(true, '正在打包 Mod')
  try {
    for (const file of outputs) state.zip.file(file.path, file.content)
    const blob = await state.zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      streamFiles: true
    }, (meta) => {
      $('#project-health-sub').textContent = `正在压缩 ${Math.floor(meta.percent)}%`
    })
    const ext = /\.(jar|zip)$/i.exec(state.fileName)?.[1]?.toLowerCase() || 'jar'
    const base = state.fileName.replace(/\.(jar|zip)$/i, '') || 'mod'
    const name = `${base}-${state.targetLocale}-translated.${ext}`
    downloadBlob(blob, name)

    const translated = state.stats.translated
    state.exportHistory.unshift({
      name,
      locale: state.targetLocale,
      translated,
      time: new Date().toLocaleString('zh-CN', { hour12: false })
    })
    const outputPaths = new Set(outputs.map((item) => item.path))
    state.langFiles = state.langFiles.filter((item) => !outputPaths.has(item.path))
    for (const output of outputs) {
      const parsed = parseLanguageText(output.path, output.content)
      if (parsed) state.langFiles.push(parsed)
    }
    state.dirtyByLocale.delete(state.targetLocale)
    state.exportedLocales.add(state.targetLocale)
    renderAll()
    toast(`Mod 已打包，写入 ${outputs.length} 个语言文件。`)
  } catch (error) {
    console.error(error)
    toast('打包失败，请确认文件有效后重试。', 'error')
  } finally {
    setBusy(false)
  }
}

async function readModInfo(zip) {
  const fabricFile = zip.file('fabric.mod.json')
  if (fabricFile) {
    try {
      const text = await fabricFile.async('string')
      if (text.length < 300_000) {
        const data = JSON.parse(text)
        if (data.version) return `${data.name || 'Fabric Mod'} · v${data.version}`
      }
    } catch {}
  }
  const forgeFile = zip.file('META-INF/mods.toml')
  if (forgeFile) {
    try {
      const text = await forgeFile.async('string')
      const id = text.match(/^\s*modId\s*=\s*["']([^"']+)/m)?.[1]
      const version = text.match(/^\s*version\s*=\s*["']([^"']+)/m)?.[1]
      if (id || version) return [id, version && !version.includes('${') ? `v${version}` : ''].filter(Boolean).join(' · ')
    } catch {}
  }
  return ''
}

async function openMod(file) {
  if (!file) return
  if (state.busy) return
  if (file.size > MAX_ARCHIVE_SIZE) {
    toast('文件超过 300 MB 安全上限，请先确认文件来源。', 'error')
    return
  }
  if (state.dirtyByLocale.size && !window.confirm('当前有未打包的修改，打开新 Mod 后这些修改会丢失。仍要继续吗？')) return

  setBusy(true, '正在读取 Mod')
  try {
    const zip = await JSZip.loadAsync(file, { checkCRC32: false })
    const candidates = Object.values(zip.files).filter((entry) => !entry.dir && /(?:^|\/)lang\/[^/]+\.(json|lang)$/i.test(entry.name))
    const fileErrors = []
    if (candidates.length > 500) {
      throw new Error('语言文件数量超过 500 个安全上限。')
    }

    const parsed = await Promise.all(candidates.map(async (entry) => {
      const uncompressedSize = entry._data?.uncompressedSize
      if (Number(uncompressedSize) > MAX_LANGUAGE_FILE_SIZE) {
        fileErrors.push({ path: entry.name, message: '文件超过 24 MB，已跳过' })
        return null
      }
      try {
        const text = await entry.async('string')
        if (text.length > MAX_LANGUAGE_FILE_SIZE) {
          fileErrors.push({ path: entry.name, message: '文件超过 24 MB，已跳过' })
          return null
        }
        return parseLanguageText(entry.name, text)
      } catch (error) {
        fileErrors.push({ path: entry.name, message: error.message || '格式无法解析' })
        return null
      }
    }))

    state.zip = zip
    state.fileName = file.name
    state.langFiles = parsed.filter(Boolean)
    state.fileErrors = fileErrors
    state.fileInfo = [formatBytes(file.size), await readModInfo(zip) || '浏览器本地解析'].filter(Boolean).join(' · ')
    state.isDemo = false
    state.drafts.clear()
    state.dirtyByLocale.clear()
    state.exportedLocales.clear()
    state.sourceLocale = state.langFiles.some((item) => item.locale === 'en_us')
      ? 'en_us'
      : state.langFiles[0]?.locale || 'en_us'
    if (state.targetLocale === state.sourceLocale) {
      state.targetLocale = ['zh_cn', 'zh_tw', 'ja_jp', 'en_us'].find((locale) => locale !== state.sourceLocale) || 'zh_cn'
    }
    state.page = 1
    state.selected.clear()
    renderLanguageControls()
    rebuildEntries()
    renderAll()

    if (!state.langFiles.length) {
      toast(fileErrors.length ? '找到了语言文件，但格式无法读取。' : '这个 Mod 中没有找到 .json 或 .lang 语言文件。', 'error')
    } else if (fileErrors.length) {
      toast(`已读取 ${state.langFiles.length} 个语言文件，${fileErrors.length} 个文件格式异常并已跳过。`, 'error')
    } else {
      toast(`已载入 ${state.fileName}，识别到 ${state.langFiles.length} 个语言文件。`)
    }
  } catch (error) {
    console.error(error)
    toast(error.message || '无法解包该文件，请确认它是有效的 JAR 或 ZIP。', 'error')
  } finally {
    setBusy(false)
  }
}

async function parseTranslationFile(file) {
  if (file.size > MAX_LANGUAGE_FILE_SIZE) throw new Error('翻译文件超过 24 MB 安全上限。')
  const text = await file.text()
  const format = file.name.toLowerCase().endsWith('.lang') ? 'lang' : 'json'
  if (format === 'json') {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('语言 JSON 顶层需要是对象。')
    return { data: new Map(Object.entries(raw).filter(([, value]) => typeof value === 'string')) }
  }

  const data = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const sep = line.indexOf('=')
    if (sep < 0) continue
    const key = line.slice(0, sep).trim()
    if (key) data.set(key, line.slice(sep + 1).trim())
  }
  return { data }
}

async function importTranslation(file) {
  if (!file) return
  if (state.busy) return
  if (!state.entries.length) {
    toast('请先打开包含语言文件的 Mod，再导入翻译。', 'error')
    return
  }
  try {
    const imported = await parseTranslationFile(file)
    let count = 0
    for (const entry of state.entries) {
      if (!imported.data.has(entry.key)) continue
      if (setEntryTarget(entry, imported.data.get(entry.key))) count++
    }
    updateStatsUI()
    renderRows()
    if (count) toast(`已导入 ${count} 条译文，目标语言为 ${state.targetLocale}。`)
    else toast('文件中没有与当前词条匹配的 Key。', 'error')
  } catch (error) {
    toast(error.message || '翻译文件格式不正确。', 'error')
  }
}

function updateSelectionAfterBulk(action) {
  const selected = [...state.selected].map((id) => state.entryMap.get(id)).filter(Boolean)
  let count = 0
  for (const entry of selected) {
    const value = action === 'copy' ? entry.source : ''
    if (action === 'copy' && !entry.source) continue
    if (setEntryTarget(entry, value)) count++
  }
  state.selected.clear()
  updateStatsUI()
  renderRows()
  toast(action === 'copy' ? `已用原文填入 ${count} 条词目。` : `已清空 ${count} 条译文。`)
}

function focusNextPending() {
  if (!state.entries.length) return
  const focusedId = decodeURIComponent(document.activeElement?.dataset?.id || '')
  const currentIndex = state.entries.findIndex((entry) => entry.id === focusedId)
  let nextIndex = state.entries.findIndex((entry, idx) => idx > currentIndex && !entry.target.trim())
  if (nextIndex < 0) nextIndex = state.entries.findIndex((entry) => !entry.target.trim())
  if (nextIndex < 0) {
    toast('所有词条都已填写。')
    return
  }
  state.filter = 'all'
  state.query = ''
  $('#search').value = ''
  state.page = Math.floor(nextIndex / PAGE_SIZE) + 1
  renderRows()
  requestAnimationFrame(() => {
    const next = state.entries[nextIndex]
    const encoded = encodeURIComponent(next.id)
    const field = [...document.querySelectorAll('[data-target-entry]')].find((node) => node.dataset.id === encoded)
    field?.focus()
  })
}

$('#open-mod').addEventListener('click', () => $('#mod-file').click())
$('#side-project').addEventListener('click', () => $('#mod-file').click())
$('#import-translation').addEventListener('click', () => $('#translation-file').click())
$('#pack-mod').addEventListener('click', packMod)
$('#project-more').addEventListener('click', downloadTargetFiles)
$('#mod-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) openMod(file)
})
$('#translation-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) importTranslation(file)
})
$('#source-language').addEventListener('change', onSourceLanguageChange)
$('#target-language').addEventListener('change', changeTargetLanguage)
$('#target-language').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    changeTargetLanguage()
    $('#target-language').blur()
  }
})
let searchTimer
$('#search').addEventListener('input', (event) => {
  state.query = event.target.value
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    state.page = 1
    renderRows()
  }, 70)
})
for (const tab of document.querySelectorAll('.filter-tab')) {
  tab.addEventListener('click', () => setFilter(tab.dataset.filter))
}
$('#select-visible').addEventListener('change', (event) => {
  for (const entry of state.visibleEntries) {
    if (event.target.checked) state.selected.add(entry.id)
    else state.selected.delete(entry.id)
  }
  renderRows()
})
$('#entry-list').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-select-entry]')
  if (!checkbox) return
  const id = decodeURIComponent(checkbox.dataset.id)
  if (checkbox.checked) state.selected.add(id)
  else state.selected.delete(id)
  updateSelectionUI()
  checkbox.closest('.entry-row')?.classList.toggle('selected', checkbox.checked)
})
$('#entry-list').addEventListener('input', (event) => {
  const textarea = event.target.closest('[data-target-entry]')
  if (!textarea) return
  const entry = state.entryMap.get(decodeURIComponent(textarea.dataset.id))
  if (!entry) return
  setEntryTarget(entry, textarea.value)
  fitTextarea(textarea)
  updateRow(entry)
  updateStatsUI()
})
$('#entry-list').addEventListener('focusout', (event) => {
  if (!event.target.matches('[data-target-entry]')) return
  window.setTimeout(() => {
    if (!$('#entry-list').contains(document.activeElement)) renderRows()
  }, 0)
})
$('#copy-source-selected').addEventListener('click', () => updateSelectionAfterBulk('copy'))
$('#clear-selected').addEventListener('click', () => updateSelectionAfterBulk('clear'))
$('#clear-selection').addEventListener('click', () => {
  state.selected.clear()
  updateSelectionUI()
  for (const row of document.querySelectorAll('.entry-row')) row.classList.remove('selected')
})
$('#prev-page').addEventListener('click', () => {
  if (state.page > 1) {
    state.page--
    renderRows()
  }
})
$('#next-page').addEventListener('click', () => {
  state.page++
  renderRows()
})
$('#empty-clear').addEventListener('click', () => {
  state.filter = 'all'
  state.query = ''
  $('#search').value = ''
  state.page = 1
  renderRows()
})
$('#show-pending').addEventListener('click', () => {
  setFilter('pending')
  $('#work-layout').scrollIntoView({ behavior: 'smooth', block: 'start' })
})
$('#quality-jump').addEventListener('click', () => {
  setFilter('pending')
  $('#work-layout').scrollIntoView({ behavior: 'smooth', block: 'start' })
})
$('#file-detail-button').addEventListener('click', showFileDetails)
$('#help-button').addEventListener('click', showHelp)
$('#progress-info').addEventListener('click', () => toast('完成率按已填写的非空译文计算。'))
$('#modal-close').addEventListener('click', closeModal)
$('#modal-backdrop').addEventListener('click', (event) => {
  if (event.target === $('#modal-backdrop')) closeModal()
})
for (const item of document.querySelectorAll('[data-nav]')) {
  item.addEventListener('click', () => {
    for (const nav of document.querySelectorAll('.nav-item')) nav.classList.toggle('active', nav === item)
    if (item.dataset.nav === 'files') {
      $('#files-card').scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else if (item.dataset.nav === 'exports') {
      showHistory()
    } else {
      $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
}

document.addEventListener('keydown', (event) => {
  const modalOpen = !$('#modal-backdrop').hidden
  if (event.key === 'Escape' && modalOpen) {
    closeModal()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    if (!state.busy) $('#mod-file').click()
    return
  }
  const active = document.activeElement
  const isTyping = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
  if (event.key === '/' && !isTyping && !modalOpen) {
    event.preventDefault()
    $('#search').focus()
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && active?.matches('[data-target-entry]')) {
    event.preventDefault()
    focusNextPending()
  }
})

let dragDepth = 0
const dropOverlay = $('#drop-overlay')
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return
  event.preventDefault()
  dragDepth++
  dropOverlay.classList.add('visible')
})
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
})
document.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dropOverlay.classList.remove('visible')
})
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return
  event.preventDefault()
  dragDepth = 0
  dropOverlay.classList.remove('visible')
  const file = event.dataTransfer.files[0]
  if (/\.(jar|zip)$/i.test(file.name)) openMod(file)
  else if (/\.(json|lang)$/i.test(file.name)) importTranslation(file)
  else toast('请拖入 .jar、.zip、.json 或 .lang 文件。', 'error')
})

window.addEventListener('beforeunload', (event) => {
  if (!state.dirtyByLocale.size) return
  event.preventDefault()
  event.returnValue = ''
})

bootSample()
