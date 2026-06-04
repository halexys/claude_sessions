// Minimal markdown renderer — no external deps, no dangerouslySetInnerHTML.
// Supports: fenced code, inline code, bold, italic, links, lists, headers.
// Renders to React elements (escaping is automatic since React text nodes
// don't interpret HTML).

function splitInline(text) {
  // Returns a flat array of segments: { kind, ... }
  // Strategy: scan token-by-token honouring inline code first.
  const out = []
  let i = 0
  while (i < text.length) {
    const tickStart = text.indexOf('`', i)
    if (tickStart === -1) { out.push(...parseRich(text.slice(i))); break }
    const tickEnd = text.indexOf('`', tickStart + 1)
    if (tickEnd === -1) { out.push(...parseRich(text.slice(i))); break }
    if (tickStart > i) out.push(...parseRich(text.slice(i, tickStart)))
    out.push({ kind: 'code', text: text.slice(tickStart + 1, tickEnd) })
    i = tickEnd + 1
  }
  return out
}

// Parses bold/italic/links into segments. No HTML, just structured tokens.
function parseRich(text) {
  const segs = []
  const re = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1]) segs.push({ kind: 'bold',   text: m[2] })
    else if (m[3]) segs.push({ kind: 'italic', text: m[4] })
    else if (m[5]) segs.push({ kind: 'link',   text: m[6], href: m[7] })
    last = re.lastIndex
  }
  if (last < text.length) segs.push({ kind: 'text', text: text.slice(last) })
  return segs
}

function Inline({ text }) {
  const segs = splitInline(text)
  return segs.map((s, i) => {
    if (s.kind === 'code') return (
      <code key={i} className="px-1.5 py-0.5 rounded bg-slate-800 text-amber-200 text-[0.85em] font-mono">
        {s.text}
      </code>
    )
    if (s.kind === 'bold')   return <strong key={i}>{s.text}</strong>
    if (s.kind === 'italic') return <em key={i}>{s.text}</em>
    if (s.kind === 'link') {
      // Only allow http/https (regex already enforces, defence in depth)
      const safe = /^https?:\/\//i.test(s.href) ? s.href : '#'
      return (
        <a key={i} href={safe} target="_blank" rel="noreferrer noopener"
           className="text-blue-400 underline">{s.text}</a>
      )
    }
    return <span key={i}>{s.text}</span>
  })
}

function CodeBlock({ lang, code }) {
  return (
    <pre className="bg-slate-950 border border-slate-700 rounded-lg p-3 overflow-x-auto my-2 text-xs font-mono leading-relaxed">
      {lang && <div className="text-slate-500 text-[10px] mb-1 uppercase tracking-wider">{lang}</div>}
      <code className="text-slate-200 whitespace-pre">{code}</code>
    </pre>
  )
}

export default function MarkdownLite({ text }) {
  if (!text) return null
  const blocks = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w+)?$/)
    if (fence) {
      const lang = fence[1] || ''
      const start = i + 1
      let end = start
      while (end < lines.length && !/^```$/.test(lines[end])) end++
      blocks.push({ kind: 'code', lang, text: lines.slice(start, end).join('\n') })
      i = end + 1
      continue
    }
    if (/^[\-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[\-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-*]\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (line.trim() === '') { i++; continue }
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^[\-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^#{1,3}\s+/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    blocks.push({ kind: 'p', text: para.join('\n') })
  }
  return (
    <div className="text-sm leading-relaxed text-slate-100 break-words">
      {blocks.map((b, idx) => {
        if (b.kind === 'code') return <CodeBlock key={idx} lang={b.lang} code={b.text} />
        if (b.kind === 'h') {
          const cls = b.level === 1 ? 'text-lg font-bold mt-2 mb-1'
                    : b.level === 2 ? 'text-base font-bold mt-2 mb-1'
                    : 'text-sm font-bold mt-1.5 mb-0.5'
          return <div key={idx} className={cls}><Inline text={b.text} /></div>
        }
        if (b.kind === 'ul') return (
          <ul key={idx} className="list-disc pl-5 my-1.5 space-y-1">
            {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
          </ul>
        )
        if (b.kind === 'ol') return (
          <ol key={idx} className="list-decimal pl-5 my-1.5 space-y-1">
            {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
          </ol>
        )
        return <p key={idx} className="my-1.5"><Inline text={b.text} /></p>
      })}
    </div>
  )
}
