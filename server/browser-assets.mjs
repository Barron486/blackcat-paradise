import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

const origin='https://game.invalid';
// Version both entry scripts and their imports. A fresh HTML page must not mix
// current game rules with an older module still in the browser/CDN cache.
export function browserAssets(sources){
  const versions=new Map(Object.entries(sources).map(([file,source])=>[file,`${file}?v=${createHash('sha256').update(source).digest('hex').slice(0,16)}`]));
  const imports={};
  for(const [file,version]of versions)if(file.endsWith('.js'))imports[file]=version;
  for(const [file,source]of Object.entries(sources))if(file.endsWith('.js')){
    for(const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)){
      const specifier=match[1];if(!specifier.startsWith('.')&&!specifier.startsWith('/'))continue;
      const url=new URL(specifier,origin+file);
      if(url.origin===origin&&versions.has(url.pathname))imports[url.pathname+url.search]=versions.get(url.pathname);
    }
  }
  return {
    imports,
    html(source){
      const rewritten=source.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=["'])([^"']+)(["'])/g,(match,start,ref,end)=>{
        const url=new URL(ref,origin+'/');
        return url.origin===origin&&versions.has(url.pathname)?start+versions.get(url.pathname)+url.hash+end:match;
      });
      return rewritten.includes('type="module"')?rewritten.replace('</head>',`<script type="importmap">${JSON.stringify({imports}).replace(/</g,'\\u003c')}</script></head>`):rewritten;
    }
  };
}

export function loadBrowserAssets(root){
  const sources={};
  const visit=folder=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())visit(file);
      else if(/\.(js|css)$/.test(entry.name))sources['/'+path.relative(root,file).split(path.sep).join('/')]=readFileSync(file,'utf8');
    }
  };
  for(const folder of ['js','css','online','shared'])visit(path.join(root,folder));
  return browserAssets(sources);
}
