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
    const expires  = (c.expires && c.expires > 0) ? Math.round(c.expires * 1000) : -1;
    return `[${name},${value},${domain},${secure},${httpOnly},${expires}]`;
  });

  const cArray = `[${rows.join(',')}]`;

  // @match explícito para cada subdomínio — *.uber.com não pega subdomínios em todos os gerenciadores
  const header = [
    '// ==UserScript==',
    '// @name         Socure LINK Login',
    '// @namespace    User Name',
    '// @version      3.1',
    '// @description  Vendido por @ddbicos_bot',
    '// @match        https://uber.com/*',
    '// @match        https://*.uber.com/*',
    '// @match        https://auth.uber.com/*',
    '// @match        https://drivers.uber.com/*',
    '// @match        https://bonjour.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
    '// @ts-nocheck',
  ].join('\n');

  /* eslint-disable no-undef */
  const body =
    `(function(){` +
    `var H=window.location.hostname;` +
    `console.log('[SocureLink] rodando em',H);` +  // debug: confirma que script rodou
    `var C=${cArray};` +
    `var ok=function(d){d=d.replace(/^[.]/,'');return H===d||H.endsWith('.'+d)};` +
    `var EX=Date.now()+3154e7;` +
    `var RAN='__scr_done';` +
    `var doRedirect=function(){` +
      `if(sessionStorage.getItem(RAN))return;` +
      `sessionStorage.setItem(RAN,'1');` +
      `console.log('[SocureLink] doRedirect chamado, H=',H);` +
      // Em auth.uber.com: navega direto para drivers (o auth já tem os cookies, deixa ele resolver)
      `if(H==='auth.uber.com'){` +
        `console.log('[SocureLink] em auth, indo para drivers...');` +
        `location.href='https://drivers.uber.com/';` +
        `return;` +
      `}` +
      `if(H==='drivers.uber.com'){console.log('[SocureLink] já em drivers, ok.');return;}` +
      `location.href='https://auth.uber.com/';` +
    `};` +
    `if(typeof GM_cookie!='undefined'){` +
      `console.log('[SocureLink] GM_cookie disponível, injetando',C.length,'cookies...');` +
      `var total=C.length,done=0;` +
      `C.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h&&ok(d)){var ck=n+'='+v+';path=/;expires='+new Date(e).toUTCString()+(s?';secure':'')+'';try{document.cookie=ck;}catch(x){}}` +
        `GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,''),path:'/',secure:!!s,httpOnly:!!h,expirationDate:Math.floor(e/1000)},function(){` +
          `done++;` +
          `if(done>=total){console.log('[SocureLink] todos cookies setados, redirecionando...');doRedirect();}` +
        `});` +
      `});` +
    `}else{` +
      `console.log('[SocureLink] GM_cookie INDISPONIVEL, usando document.cookie apenas');` +
      `C.forEach(function(c){` +
        `var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;` +
        `if(!h&&ok(d)){var ck=n+'='+v+';path=/;expires='+new Date(e).toUTCString()+(s?';secure':'')+'';try{document.cookie=ck;}catch(x){}}` +
      `});` +
      `doRedirect();` +
    `}` +
    `})()` ;
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
