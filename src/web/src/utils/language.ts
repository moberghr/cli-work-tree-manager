import hljs from 'highlight.js';
import cshtmlRazor from 'highlightjs-cshtml-razor';

// Razor (.cshtml/.razor) isn't part of the highlight.js bundle, so register the
// dedicated grammar here — both highlight consumers (DiffFile, FileApp) import
// this module before they call hljs.highlight, and hljs is a module singleton.
hljs.registerLanguage('cshtml-razor', cshtmlRazor);

/** Map file extension → highlight.js language identifier. Only languages in
 *  the "common" hljs bundle (plus the cshtml-razor grammar registered above)
 *  are mapped — others fall through to no highlight. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  py: 'python', pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  cshtml: 'cshtml-razor', razor: 'cshtml-razor',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql',
  dockerfile: 'dockerfile',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  vue: 'javascript',
};

export function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? '';
}
