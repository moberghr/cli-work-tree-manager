import hljs from 'highlight.js/lib/core';
import cshtmlRazor from 'highlightjs-cshtml-razor';
import langBash from 'highlight.js/lib/languages/bash';
import langC from 'highlight.js/lib/languages/c';
import langCpp from 'highlight.js/lib/languages/cpp';
import langCsharp from 'highlight.js/lib/languages/csharp';
import langCss from 'highlight.js/lib/languages/css';
import langDart from 'highlight.js/lib/languages/dart';
import langDockerfile from 'highlight.js/lib/languages/dockerfile';
import langGo from 'highlight.js/lib/languages/go';
import langIni from 'highlight.js/lib/languages/ini';
import langJava from 'highlight.js/lib/languages/java';
import langJavascript from 'highlight.js/lib/languages/javascript';
import langJson from 'highlight.js/lib/languages/json';
import langKotlin from 'highlight.js/lib/languages/kotlin';
import langLess from 'highlight.js/lib/languages/less';
import langLua from 'highlight.js/lib/languages/lua';
import langMarkdown from 'highlight.js/lib/languages/markdown';
import langPhp from 'highlight.js/lib/languages/php';
import langPowershell from 'highlight.js/lib/languages/powershell';
import langPython from 'highlight.js/lib/languages/python';
import langR from 'highlight.js/lib/languages/r';
import langRuby from 'highlight.js/lib/languages/ruby';
import langRust from 'highlight.js/lib/languages/rust';
import langScala from 'highlight.js/lib/languages/scala';
import langScss from 'highlight.js/lib/languages/scss';
import langSql from 'highlight.js/lib/languages/sql';
import langSwift from 'highlight.js/lib/languages/swift';
import langTypescript from 'highlight.js/lib/languages/typescript';
import langXml from 'highlight.js/lib/languages/xml';
import langYaml from 'highlight.js/lib/languages/yaml';

// highlight.js's core with only the languages EXT_TO_LANG names (the full
// build's ~190 grammars were most of the dashboard's code), plus Razor
// (.cshtml/.razor), which isn't in highlight.js. Both highlight consumers
// (DiffFile, FileApp) import this module before they call hljs.highlight, and
// hljs is a module singleton. A language added to EXT_TO_LANG is registered
// here too (a test checks).
hljs.registerLanguage('bash', langBash);
hljs.registerLanguage('c', langC);
hljs.registerLanguage('cpp', langCpp);
hljs.registerLanguage('csharp', langCsharp);
hljs.registerLanguage('css', langCss);
hljs.registerLanguage('dart', langDart);
hljs.registerLanguage('dockerfile', langDockerfile);
hljs.registerLanguage('go', langGo);
hljs.registerLanguage('ini', langIni);
hljs.registerLanguage('java', langJava);
hljs.registerLanguage('javascript', langJavascript);
hljs.registerLanguage('json', langJson);
hljs.registerLanguage('kotlin', langKotlin);
hljs.registerLanguage('less', langLess);
hljs.registerLanguage('lua', langLua);
hljs.registerLanguage('markdown', langMarkdown);
hljs.registerLanguage('php', langPhp);
hljs.registerLanguage('powershell', langPowershell);
hljs.registerLanguage('python', langPython);
hljs.registerLanguage('r', langR);
hljs.registerLanguage('ruby', langRuby);
hljs.registerLanguage('rust', langRust);
hljs.registerLanguage('scala', langScala);
hljs.registerLanguage('scss', langScss);
hljs.registerLanguage('sql', langSql);
hljs.registerLanguage('swift', langSwift);
hljs.registerLanguage('typescript', langTypescript);
hljs.registerLanguage('xml', langXml);
hljs.registerLanguage('yaml', langYaml);
hljs.registerLanguage('cshtml-razor', cshtmlRazor);

/** Map file extension → highlight.js language identifier. Only languages in
 *  the "common" hljs bundle (plus the cshtml-razor grammar registered above)
 *  are mapped — others fall through to no highlight. */
export const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  csx: 'csharp',
  cshtml: 'cshtml-razor',
  razor: 'cshtml-razor',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  // .NET / C# project & markup files — all XML under the hood.
  resx: 'xml',
  slnx: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',
  nuspec: 'xml',
  xaml: 'xml',
  axaml: 'xml',
  resw: 'xml',
  config: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
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
