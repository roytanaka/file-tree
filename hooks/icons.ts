// Nerd Font (v3) glyphs and colours, after nvim-web-devicons.

export type Icon = { glyph: string; color: string }

export const FOLDER_CLOSED: Icon = { glyph: '\u{e5ff}', color: '#7ebae4' }
export const FOLDER_OPEN: Icon = { glyph: '\u{e5fe}', color: '#7ebae4' }
const FILE: Icon = { glyph: '\u{f15b}', color: '#6d8086' }

const JS: Icon = { glyph: '\u{e74e}', color: '#cbcb41' }
const REACT: Icon = { glyph: '\u{e7ba}', color: '#20c2e3' }
const IMAGE: Icon = { glyph: '\u{e60d}', color: '#a074c4' }
const LOCK: Icon = { glyph: '\u{f023}', color: '#bbbbbb' }

const BY_NAME: Record<string, Icon> = {
  'package.json': { glyph: '\u{e71e}', color: '#e8274b' },
  'package-lock.json': { glyph: '\u{e71e}', color: '#7a0d21' },
  'yarn.lock': { glyph: '\u{e6a7}', color: '#2c8ebb' },
  '.gitignore': { glyph: '\u{e702}', color: '#f54d27' },
  '.gitattributes': { glyph: '\u{e702}', color: '#f54d27' },
  '.prettierrc': { glyph: '\u{e6b4}', color: '#4285f4' },
  'babel.config.js': { glyph: '\u{e639}', color: '#cbcb41' },
  'tailwind.config.js': { glyph: '\u{f13ff}', color: '#20c2e3' },
  'tailwind.config.cjs': { glyph: '\u{f13ff}', color: '#20c2e3' },
  'readme.md': { glyph: '\u{f48a}', color: '#ededed' },
  'license': { glyph: '\u{e60a}', color: '#d0bf41' },
  'dockerfile': { glyph: '\u{f308}', color: '#458ee6' },
  'favicon.ico': { glyph: '\u{e623}', color: '#cbcb41' },
}

const BY_EXT: Record<string, Icon> = {
  js: JS, mjs: JS, cjs: JS,
  ts: { glyph: '\u{e628}', color: '#519aba' },
  mts: { glyph: '\u{e628}', color: '#519aba' },
  jsx: REACT, tsx: REACT,
  vue: { glyph: '\u{e6a0}', color: '#8dc149' },
  svelte: { glyph: '\u{e697}', color: '#ff3e00' },
  html: { glyph: '\u{e736}', color: '#e44d26' },
  htm: { glyph: '\u{e736}', color: '#e44d26' },
  css: { glyph: '\u{e749}', color: '#42a5f5' },
  scss: { glyph: '\u{e603}', color: '#f55385' },
  sass: { glyph: '\u{e603}', color: '#f55385' },
  json: { glyph: '\u{e60b}', color: '#cbcb41' },
  md: { glyph: '\u{e73e}', color: '#dddddd' },
  mdx: { glyph: '\u{e73e}', color: '#519aba' },
  yml: { glyph: '\u{e6a8}', color: '#6d8086' },
  yaml: { glyph: '\u{e6a8}', color: '#6d8086' },
  toml: { glyph: '\u{e6b2}', color: '#9c4221' },
  py: { glyph: '\u{e606}', color: '#ffbc03' },
  rb: { glyph: '\u{e791}', color: '#701516' },
  go: { glyph: '\u{e627}', color: '#00add8' },
  rs: { glyph: '\u{e7a8}', color: '#dea584' },
  sh: { glyph: '\u{e795}', color: '#4d5a5e' },
  zsh: { glyph: '\u{e795}', color: '#89e051' },
  svg: { glyph: '\u{f0721}', color: '#ffb13b' },
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, ico: IMAGE,
  map: { glyph: '\u{f0ac}', color: '#6d8086' },
  lock: LOCK,
  txt: { glyph: '\u{f15c}', color: '#89e051' },
}

export function fileIcon(name: string): Icon {
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named !== undefined) return named
  if (lower.startsWith('.eslintrc') || lower.startsWith('eslint.config')) {
    return { glyph: '\u{e655}', color: '#4b32c3' }
  }
  if (lower.startsWith('.env')) return { glyph: '\u{f462}', color: '#faf743' }
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || FILE
}
