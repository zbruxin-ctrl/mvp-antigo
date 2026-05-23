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
    'uber.com',
    '.uber.com',
    'auth.uber.com',
    '.auth.uber.com',
    'drivers.uber.com',
    '.drivers.uber.com',
    'bonjour.uber.com',
    '.bonjour.uber.com',
  ];

  const filtered = cookies.filter((c) =>
    ALLOWED_DOMAINS.some((d) => {
      const cookieDomain = c.domain.replace(/^\./, '');
      const allowedDomain = d.replace(/^\./, '');
      return cookieDomain === allowedDomain || cookieDomain.endsWith('.' + allowedDomain);
    })
  );

  const rows = filtered.map((c) => {
    const name     = JSON.stringify(c.name);
    const value    = JSON.stringify(c.value);
    // guarda o domínio ORIGINAL do Playwright (pode ter ponto ou não)
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
    '// @version      4.6',
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
    `var C=${cArray};` +
    `var EX=Math.floor(Date.now()/1000)+31536000;` +

    // ok() verifica se o cookie pertence ao hostname atual
    `var ok=function(d){var nd=d.replace(/^[.]/,'');return H===nd||H.endsWith('.'+nd);};` +

    // setCk() seta via document.cookie (não-httpOnly) + GM_cookie (todos)
    // IMPORTANTE: GM_cookie.set recebe o domínio ORIGINAL com ponto,
    // pois sem o ponto o cookie fica restrito ao host exato e não é
    // compartilhado entre subdomínios (ex: .uber.com cobre tudo)
    `var setCk=function(c,cb){` +
      `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
      `if(!h){try{document.cookie=n+'='+v+';path=/;domain='+d+';expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
      `if(typeof GM_cookie!='undefined'){GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},cb||function(){});}` +
      `else if(cb){cb();}` +
    `};` +

    `var rel=C.filter(function(c){return ok(c[2]);});` +
    `console.log('[SocureLink] H=',H,'cookies rel:',rel.length);` +

    // ── drivers.uber.com: destino final — seta e para ──
    `if(H==='drivers.uber.com'){` +
      `try{sessionStorage.removeItem('sl_injected');}catch(x){}` +
      `var tot0=rel.length,d0=0;` +
      `if(!tot0){console.log('[SocureLink] drivers: sem cookies rel, carregando.');return;}` +
      `rel.forEach(function(c){setCk(c,function(){d0++;if(d0>=tot0){console.log('[SocureLink] drivers: '+d0+' cookies setados.');}});});` +
      `return;` +
    `}` +

    // ── auth.uber.com: seta cookies → redireciona para drivers ──
    `if(H==='auth.uber.com'){` +
      `var already=false;` +
      `try{already=(sessionStorage.getItem('sl_injected')==='1');}catch(x){}` +
      `if(already){console.log('[SocureLink] auth: guard ativo, parado.');return;}` +
      `try{sessionStorage.setItem('sl_injected','1');}catch(x){}` +
      `var tot1=rel.length,d1=0,fired1=false;` +
      `var go1=function(){if(fired1)return;fired1=true;console.log('[SocureLink] auth → drivers ('+d1+'/'+tot1+' cookies)');location.replace('https://drivers.uber.com/');};` +
      `var t1=setTimeout(go1,2500);` +
      `if(!tot1){clearTimeout(t1);go1();return;}` +
      `rel.forEach(function(c){setCk(c,function(){d1++;if(d1>=tot1){clearTimeout(t1);go1();}});});` +
      `return;` +
    `}` +

    // ── qualquer outro domínio uber: seta cookies → vai para auth ──
    `var tot2=rel.length,d2=0,fired2=false;` +
    `var go2=function(){if(fired2)return;fired2=true;console.log('[SocureLink] → auth ('+d2+'/'+tot2+' cookies)');location.replace('https://auth.uber.com/');};` +
    `var t2=setTimeout(go2,2500);` +
    `if(!tot2){clearTimeout(t2);go2();return;}` +
    `rel.forEach(function(c){setCk(c,function(){d2++;if(d2>=tot2){clearTimeout(t2);go2();}});});` +
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
