// The highlightjs-cshtml-razor package ships no type declarations. Its default
// export is a highlight.js language definer: (hljs) => Language.
declare module 'highlightjs-cshtml-razor' {
  import type { LanguageFn } from 'highlight.js';
  const definer: LanguageFn;
  export default definer;
}
