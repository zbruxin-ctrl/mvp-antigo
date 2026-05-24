/**
 * accountStore — abstração de persistência de contas.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Account } from '../types/account';
import type { Cookie } from 'playwright';

const DATA_DIR  = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

const MAX_ACCOUNTS = 200;

function readAll(): Account[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as Account[]) : [];
  } catch {
    return [];
  }
}

function writeAll(accounts: Account[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

export function buildTampermonkeyScript(cookies: Cookie[]): string {
  const ALLOWED_DOMAINS = [
    'uber.com', '.uber.com',
    'auth.uber.com', '.auth.uber.com',
    'drivers.uber.com', '.drivers.uber.com',
    'bonjour.uber.com', '.bonjour.uber.com',
  ];

  const filtered = cookies.filter((c) =>
    ALLOWED_DOMAINS.some((d) => {
      const cd = c.domain.replace(/^\./, '');
      const ad = d.replace(/^\./, '');
      return cd === ad || cd.endsWith('.' + ad);
    })
  );

  const rows = filtered.map((c) => {
    const name     = JSON.stringify(c.name);
    const value    = JSON.stringify(c.value);
    const domain   = JSON.stringify(c.domain);
    const secure   = c.secure   ? 1 : 0;
    const httpOnly = c.httpOnly ? 1 : 0;
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const cArray = `[${rows.join(',')}]`;

  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      5.3',
    '// @description  Vendido por @ddbicos_bot',
    '// @match        https://uber.com/*',
    '// @match        https://*.uber.com/*',
    '// @match        https://auth.uber.com/*',
    '// @match        https://drivers.uber.com/*',
    '// @match        https://bonjour.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');

  const body =
    `(function(){` +
    `var H=window.location.hostname;` +
    `var P=window.location.search;` +
    `var C=${cArray};` +
    `var EX=Math.floor(Date.now()/1000)+31536000;` +
    `var ok=function(d){var nd=d.replace(/^[.]/,'');return H===nd||H.endsWith('.'+nd);};` +
    `var setCk=function(c,cb){` +
      `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
      `if(!h){try{document.cookie=n+'='+v+';path=/;domain='+d+';expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
      `if(typeof GM_cookie!='undefined'){GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},cb||function(){});}` +
      `else if(cb){cb();}` +
    `};` +
    `var rel=C.filter(function(c){return ok(c[2]);});` +
    `console.log('[SocureLink] H=',H,'rel:',rel.length,'P=',P);` +

    // drivers/?sl=1: seta cookies e limpa URL
    `if(H==='drivers.uber.com'&&P.indexOf('sl=1')!==-1){` +
      `var tot=rel.length,cnt=0;` +
      `var done=function(){console.log('[SocureLink] drivers: '+cnt+'/'+tot+' cookies setados.');try{var clean=window.location.href.replace(/[?&]sl=1/,'');history.replaceState(null,'',clean);}catch(x){}};` +
      `if(!tot){done();return;}` +
      `rel.forEach(function(c){setCk(c,function(){cnt++;if(cnt>=tot){done();}});});` +
      `return;` +
    `}` +

    // drivers e bonjour: nao interferir nunca
    `if(H==='drivers.uber.com'||H==='bonjour.uber.com'){console.log('[SocureLink] '+H+' sem acao.');return;}` +

    // auth: se sid presente deixa Uber, senao injeta e vai para drivers/?sl=1
    `if(H==='auth.uber.com'){` +
      `var hasSid=(document.cookie.indexOf('sid=')!==-1);` +
      `if(hasSid){console.log('[SocureLink] auth: sid presente, deixando Uber agir.');return;}` +
      `var tot1=rel.length,c1=0,f1=false;` +
      `var go1=function(){if(f1)return;f1=true;console.log('[SocureLink] auth→drivers ('+c1+'/'+tot1+')');location.replace('https://drivers.uber.com/?sl=1');};` +
      `var t1=setTimeout(go1,2500);` +
      `if(!tot1){clearTimeout(t1);go1();return;}` +
      `rel.forEach(function(c){setCk(c,function(){c1++;if(c1>=tot1){clearTimeout(t1);go1();}});});` +
      `return;` +
    `}` +

    // qualquer outro dominio uber: nao interferir
    `console.log('[SocureLink] '+H+' nao mapeado, sem acao.');` +
    `})();`;

  return `${header}\n${body}\n`;
}

export function save(data: Omit<Account, 'id' | 'createdAt'>): Account {
  const account: Account = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...data,
    tampermonkeyScript: buildTampermonkeyScript(data.cookies as Cookie[]),
  };
  const all = readAll();
  all.unshift(account);
  writeAll(all.slice(0, MAX_ACCOUNTS));
  return account;
}

export function list(): Account[] {
  return readAll();
}

export function remove(id: string): boolean {
  const all = readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export function regenScript(id: string): Account | null {
  const all = readAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const account = all[idx]!;
  account.tampermonkeyScript = buildTampermonkeyScript((account.cookies ?? []) as Cookie[]);
  writeAll(all);
  return account;
}
