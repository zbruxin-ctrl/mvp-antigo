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
    // Playwright salva expires em segundos — mantemos em segundos para GM_cookie.set (expirationDate)
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const cArray = `[${rows.join(',')}]`;

  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      4.0',
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
    `console.log('[SocureLink] rodando em',H);` +

    `var C=${cArray};` +

    // Filtra cookies relevantes para o domínio atual
    `var ok=function(d){d=d.replace(/^[.]/,'');return H===d||H.endsWith('.'+d)};` +

    // expires em segundos (Playwright) → GM_cookie usa segundos, document.cookie usa ms
    `var EX=Math.floor(Date.now()/1000)+31536000;` +

    // Fase 2: já estamos em drivers.uber.com, seta cookies desse domínio e para
    `if(H==='drivers.uber.com'){` +
      `console.log('[SocureLink] FASE 2 — setando cookies de drivers...');` +
      `var rel=C.filter(function(c){return ok(c[2]);});` +
      `console.log('[SocureLink] cookies para drivers:',rel.length);` +
      `if(!rel.length){console.log('[SocureLink] nenhum cookie de drivers, ok.');return;}` +
      `if(typeof GM_cookie!='undefined'){` +
        `rel.forEach(function(c){` +
          `var n=c[0],v=c[1],d=c[2].replace(/^[.]/,''),s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
          `if(!h){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
          `GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){});` +
        `});` +
      `}` +
      `return;` +
    `}` +

    // Fase 1: qualquer outro domínio → seta todos os cookies e redireciona para auth.uber.com
    // auth.uber.com é onde o Uber valida a sessão — os cookies de .uber.com precisam estar lá
    `var DONE='__scr_done_v4';` +
    `if(sessionStorage.getItem(DONE)){console.log('[SocureLink] já executou nesta aba, skip.');return;}` +
    `sessionStorage.setItem(DONE,'1');` +

    `console.log('[SocureLink] FASE 1 — injetando',C.length,'cookies e redirecionando para auth...');` +

    `var doRedirect=function(){` +
      `console.log('[SocureLink] todos cookies setados → indo para auth.uber.com');` +
      `location.href='https://auth.uber.com/';` +
    `};` +

    `if(typeof GM_cookie!='undefined'){` +
      `console.log('[SocureLink] GM_cookie disponível');` +
      `var total=C.length,done=0;` +
      `C.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2].replace(/^[.]/,''),s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
        `GM_cookie.set({name:n,value:v,domain:d,path:'/',secure:!!s,httpOnly:!!h,expirationDate:e},function(){` +
          `done++;` +
          `if(done>=total){doRedirect();}` +
        `});` +
      `});` +
    `}else{` +
      `console.log('[SocureLink] GM_cookie INDISPONIVEL — só document.cookie');` +
      `C.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h&&ok(d)){try{document.cookie=n+'='+v+';path=/;expires='+new Date(e*1000).toUTCString()+(s?';secure':'');}catch(x){}}` +
      `});` +
      `doRedirect();` +
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
