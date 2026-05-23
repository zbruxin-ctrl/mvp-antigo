/**
 * accountStore — abstração de persistência de contas.
 *
 * Hoje: JSON em disco (data/accounts.json).
 * Migração Prisma: só trocar o corpo de save/list/delete,
 * mantendo a mesma interface exportada.
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
    '// @version      4.3',
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

  /* eslint-disable no-undef */
  const body =
    `(function(){` +
    `var H=window.location.hostname;` +
    `var C=${cArray};` +
    `var EX=Math.floor(Date.now()/1000)+31536000;` +
    `var ok=function(d){d=d.replace(/^[.]/,'');return H===d||H.endsWith('.'+d);};` +
    `var rel=C.filter(function(c){return ok(c[2]);});` +
    `console.log('[SocureLink] H=',H,'cookies:',rel.length);` +

    // drivers.uber.com: seta cookies e PARA — sem redirect, deixa o Uber carregar
    `if(H==='drivers.uber.com'){` +
      `if(typeof GM_cookie!='undefined'){` +
        `rel.forEach(function(c){` +
          `var n=c[0],v=c[1],d=c[2].replace(/^[.]/,''),s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
          `if(!h){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
          `GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){});` +
        `});` +
      `}` +
      `console.log('[SocureLink] drivers: cookies setados, carregando...');` +
      `return;` +
    `}` +

    // auth.uber.com: seta cookies e redireciona para drivers — SEM sessionStorage guard
    // location.replace evita loop (auth→drivers→para)
    `if(H==='auth.uber.com'){` +
      `if(typeof GM_cookie!='undefined'){` +
        `var total=rel.length,done=0,fired=false;` +
        `var finish=function(){if(fired)return;fired=true;console.log('[SocureLink] auth: indo para drivers...');location.replace('https://drivers.uber.com/');};` +
        `var t=setTimeout(finish,2000);` +
        `if(!rel.length){clearTimeout(t);finish();return;}` +
        `rel.forEach(function(c){` +
          `var n=c[0],v=c[1],d=c[2].replace(/^[.]/,''),s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
          `if(!h){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
          `GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){done++;if(done>=total){clearTimeout(t);finish();}});` +
        `});` +
      `}else{` +
        `rel.forEach(function(c){` +
          `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
          `if(!h&&ok(d)){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
        `});` +
        `location.replace('https://drivers.uber.com/');` +
      `}` +
      `return;` +
    `}` +

    // qualquer outro domínio: seta cookies e vai para auth
    `if(typeof GM_cookie!='undefined'){` +
      `var total2=rel.length,done2=0,fired2=false;` +
      `var finish2=function(){if(fired2)return;fired2=true;console.log('[SocureLink] indo para auth...');location.replace('https://auth.uber.com/');};` +
      `var t2=setTimeout(finish2,2000);` +
      `if(!rel.length){clearTimeout(t2);finish2();return;}` +
      `rel.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2].replace(/^[.]/,''),s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
        `GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){done2++;if(done2>=total2){clearTimeout(t2);finish2();}});` +
      `});` +
    `}else{` +
      `rel.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h&&ok(d)){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
      `});` +
      `location.replace('https://auth.uber.com/');` +
    `}` +
    `})();`;
  /* eslint-enable no-undef */

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
